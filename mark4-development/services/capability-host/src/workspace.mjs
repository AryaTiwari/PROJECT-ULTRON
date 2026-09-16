import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here=path.dirname(fileURLToPath(import.meta.url));
const mark4Root=path.resolve(here,"../../..");
const hermesHome=String(process.env.HERMES_HOME||path.join(mark4Root,".runtime","hermes-home"));
const scripts=path.join(hermesHome,"skills","productivity","google-workspace","scripts");
const setupScript=path.join(scripts,"setup.py");
const apiScript=path.join(scripts,"google_api.py");
const hermesPython=process.platform==="win32"
  ?path.join(mark4Root,".runtime","vendor","hermes-agent",".venv","Scripts","python.exe")
  :path.join(mark4Root,".runtime","vendor","hermes-agent",".venv","bin","python");

function pythonExe(){return fs.existsSync(hermesPython)?hermesPython:(process.platform==="win32"?"python":"python3");}
function run(script,args=[],timeoutMs=120000){
  return new Promise((resolve,reject)=>{
    if(!fs.existsSync(script))return reject(new Error("GOOGLE_WORKSPACE_SKILL_MISSING"));
    const child=spawn(pythonExe(),[script,...args],{cwd:mark4Root,env:process.env,stdio:["ignore","pipe","pipe"],shell:false});
    let stdout="",stderr="";
    const timer=setTimeout(()=>{try{child.kill();}catch{}reject(new Error("GOOGLE_WORKSPACE_TIMEOUT"));},timeoutMs);
    child.stdout.on("data",c=>stdout+=c.toString());
    child.stderr.on("data",c=>stderr+=c.toString());
    child.on("error",e=>{clearTimeout(timer);reject(e);});
    child.on("exit",code=>{clearTimeout(timer);resolve({code:Number(code||0),stdout:stdout.trim(),stderr:stderr.trim()});});
  });
}
function parse(value){try{return JSON.parse(value);}catch{return null;}}
export async function googleWorkspaceStatus(){
  if(!fs.existsSync(setupScript))return{status:"skill_missing",authenticated:false};
  const result=await run(setupScript,["--check"]);
  const combined=(result.stdout+"\n"+result.stderr).trim();
  if(/AUTHENTICATED/i.test(combined)&&result.code===0)return{status:"authenticated",authenticated:true,detail:combined};
  return{status:"auth_required",authenticated:false,detail:combined||"Google OAuth is not connected.",clientSecretPresent:fs.existsSync(path.join(hermesHome,"google_client_secret.json")),tokenPresent:fs.existsSync(path.join(hermesHome,"google_token.json"))};
}
export async function googleSetClientSecret(filePath){
  const target=String(filePath||"").trim();if(!target)throw new Error("GOOGLE_CLIENT_SECRET_PATH_REQUIRED");
  const result=await run(setupScript,["--client-secret",target]);
  return{ok:result.code===0,stdout:result.stdout,stderr:result.stderr};
}
export async function googleAuthUrl(services="drive,sheets"){
  const result=await run(setupScript,["--auth-url","--services",String(services||"drive,sheets"),"--format","json"]);
  const data=parse(result.stdout);return data||{ok:false,code:result.code,stdout:result.stdout,stderr:result.stderr};
}
export async function googleAuthCode(codeOrUrl){
  const value=String(codeOrUrl||"").trim();if(!value)throw new Error("GOOGLE_AUTH_CODE_REQUIRED");
  const result=await run(setupScript,["--auth-code",value,"--format","json"]);
  const data=parse(result.stdout);return data||{ok:false,code:result.code,stdout:result.stdout,stderr:result.stderr};
}
function colName(n){let s="";for(let x=n;x>0;x=Math.floor((x-1)/26))s=String.fromCharCode(65+(x-1)%26)+s;return s;}
async function gapi(args){
  const result=await run(apiScript,args);
  const data=parse(result.stdout);
  if(result.code!==0)throw new Error(data?.error||result.stderr||result.stdout||"GOOGLE_API_FAILED");
  return data??{stdout:result.stdout};
}
export async function createGoogleSheet({title="ULTRON Lead Export",sheetName="Leads",rows=[]}={}){
  const status=await googleWorkspaceStatus();
  if(!status.authenticated)return{ok:false,status:"auth_required",workspace:status,message:"Google Sheets needs one-time OAuth. Preserve the research mission and request Google Workspace connection; do not discard gathered leads."};
  if(!Array.isArray(rows)||rows.length<1)throw new Error("GOOGLE_SHEET_ROWS_REQUIRED");
  const created=await gapi(["sheets","create","--title",String(title),"--sheet-name",String(sheetName)]);
  const spreadsheetId=created.spreadsheetId||created.spreadsheet_id||created.id;
  if(!spreadsheetId)throw new Error("GOOGLE_SHEET_CREATE_RETURNED_NO_ID");
  const end=colName(Math.max(...rows.map(r=>Array.isArray(r)?r.length:0),1));
  const range=`${sheetName}!A1:${end}${rows.length}`;
  await gapi(["sheets","update",String(spreadsheetId),range,"--values",JSON.stringify(rows)]);
  return{ok:true,status:"created",spreadsheetId,spreadsheetUrl:created.spreadsheetUrl||created.spreadsheet_url||created.url||`https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,title,sheetName,rowCount:rows.length-1};
}
