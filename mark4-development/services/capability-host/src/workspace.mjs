import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mark4GoogleAuth, GOOGLE_AUTH_CONTRACT } from "./google-auth-recovery.mjs";

const here=path.dirname(fileURLToPath(import.meta.url));
const mark4Root=path.resolve(here,"../../..");
const hermesHome=mark4GoogleAuth.hermesHome;
const profileScripts=path.join(hermesHome,"skills","productivity","google-workspace","scripts");
const bundledScripts=path.join(mark4Root,".runtime","vendor","hermes-agent","skills","productivity","google-workspace","scripts");
const scripts=fs.existsSync(path.join(profileScripts,"google_api.py"))?profileScripts:bundledScripts;
const setupScript=path.join(scripts,"setup.py");
const apiScript=path.join(scripts,"google_api.py");
const metadataScript=path.join(mark4Root,"scripts","google-sheet-metadata.py");
const hermesPython=process.platform==="win32"
  ?path.join(mark4Root,".runtime","vendor","hermes-agent",".venv","Scripts","python.exe")
  :path.join(mark4Root,".runtime","vendor","hermes-agent",".venv","bin","python");

function pythonExe(){return fs.existsSync(hermesPython)?hermesPython:(process.platform==="win32"?"python":"python3");}
function run(script,args=[],timeoutMs=120000){
  return new Promise((resolve,reject)=>{
    if(!fs.existsSync(script))return reject(new Error("GOOGLE_WORKSPACE_SKILL_MISSING"));
    const child=spawn(pythonExe(),[script,...args],{cwd:mark4Root,env:{...process.env,HERMES_HOME:hermesHome},stdio:["ignore","pipe","pipe"],shell:false});
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
  if(!fs.existsSync(setupScript))return{status:"skill_missing",authenticated:false,contractVersion:GOOGLE_AUTH_CONTRACT};
  let auth;
  try{auth=await mark4GoogleAuth.ensureReady({interactive:false});}
  catch(error){return{status:error.code==="TEMPORARY_NETWORK_FAILURE"?"temporary_failure":"auth_required",authenticated:false,contractVersion:GOOGLE_AUTH_CONTRACT,authState:error.code||"AUTH_REQUIRED",detail:error.message,clientSecretPresent:fs.existsSync(mark4GoogleAuth.canonicalClientPath),tokenPresent:fs.existsSync(mark4GoogleAuth.canonicalTokenPath)};}
  if(!auth.ok)return{status:"auth_required",authenticated:false,contractVersion:GOOGLE_AUTH_CONTRACT,authState:auth.state,durable:Boolean(auth.durable),detail:"Google Workspace requires authorization.",clientSecretPresent:fs.existsSync(mark4GoogleAuth.canonicalClientPath),tokenPresent:fs.existsSync(mark4GoogleAuth.canonicalTokenPath)};
  const result=await run(setupScript,["--check"]);
  const combined=(result.stdout+"\n"+result.stderr).trim();
  if(/AUTHENTICATED/i.test(combined)&&result.code===0)return{status:"authenticated",authenticated:true,contractVersion:GOOGLE_AUTH_CONTRACT,authState:auth.state,durable:Boolean(auth.durable),detail:combined};
  return{status:"auth_required",authenticated:false,contractVersion:GOOGLE_AUTH_CONTRACT,authState:"HERMES_TOKEN_REJECTED",durable:Boolean(auth.durable),detail:combined||"Hermes Google Workspace did not accept the saved token.",clientSecretPresent:fs.existsSync(mark4GoogleAuth.canonicalClientPath),tokenPresent:fs.existsSync(mark4GoogleAuth.canonicalTokenPath)};
}
export async function googleSetClientSecret(filePath){
  const target=String(filePath||"").trim();if(!target)throw new Error("GOOGLE_CLIENT_SECRET_PATH_REQUIRED");
  const result=await run(setupScript,["--client-secret",target]);
  return{ok:result.code===0,stdout:result.stdout,stderr:result.stderr};
}
export async function googleAuthUrl(){
  // Legacy compatibility alias. Hermes' old setup.py flow generated a browser-blocked low-numbered callback port
  // and Chromium blocks that callback as ERR_UNSAFE_PORT. Use ULTRON's own
  // ephemeral 127.0.0.1 PKCE flow instead.
  return googleWorkspaceConnect();
}
export async function googleAuthCode(){
  const status=await googleWorkspaceStatus();
  return{...status,legacyAuthCodeFlowDisabled:true,message:"Manual auth-code handling is no longer required. ULTRON completes OAuth through a secure ephemeral 127.0.0.1 callback automatically."};
}
function colName(n){let s="";for(let x=n;x>0;x=Math.floor((x-1)/26))s=String.fromCharCode(65+(x-1)%26)+s;return s;}
function looksAuthFailure(value){return /auth|oauth|credential|refresh token|invalid_grant|unauthenticated|login required|token.*expired|token.*revoked/i.test(String(value||""));}
async function ensureGoogleWorkspace(options={}){
  const auth=await mark4GoogleAuth.ensureReady({interactive:options.interactive!==false,forceRefresh:Boolean(options.forceRefresh),forceReauth:Boolean(options.forceReauth)});
  if(!auth.ok){const error=new Error("Google Workspace authorization is required. Preserve the research mission and retry after connection; do not discard gathered work.");error.code="GOOGLE_AUTH_REQUIRED";error.authState=auth.state;error.workspace=auth;throw error;}
  return auth;
}
export async function googleWorkspaceConnect(){return ensureGoogleWorkspace({interactive:true,forceReauth:true});}
async function gapi(args,options={}){
  await ensureGoogleWorkspace({interactive:true,forceRefresh:Boolean(options.forceRefresh)});
  let result=await run(apiScript,args),data=parse(result.stdout);
  if(result.code!==0&&looksAuthFailure(data?.error||result.stderr||result.stdout)&&!options.authRetried){
    await ensureGoogleWorkspace({interactive:true,forceRefresh:true});
    result=await run(apiScript,args);data=parse(result.stdout);
  }
  if(result.code!==0){const error=new Error(data?.error||result.stderr||result.stdout||"GOOGLE_API_FAILED");if(looksAuthFailure(error.message))error.code="GOOGLE_AUTH_REQUIRED";throw error;}
  return data??{stdout:result.stdout};
}
const normalized=value=>String(value||"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
const quoteSheet=value=>`'${String(value||"").replace(/'/g,"''")}'`;
export async function googleSheetMetadata(spreadsheetId,options={}){
  const id=String(spreadsheetId||"").trim();if(!id)throw new Error("GOOGLE_SPREADSHEET_ID_REQUIRED");
  await ensureGoogleWorkspace({interactive:true,forceRefresh:Boolean(options.forceRefresh)});
  let result=await run(metadataScript,[id]),data=parse(result.stdout);
  if((result.code!==0||data?.error)&&looksAuthFailure(data?.error||result.stderr||result.stdout)&&!options.authRetried){
    await ensureGoogleWorkspace({interactive:true,forceRefresh:true});
    result=await run(metadataScript,[id]);data=parse(result.stdout);
  }
  if(result.code!==0||data?.error){const error=new Error(data?.error||result.stderr||result.stdout||"GOOGLE_SHEET_METADATA_FAILED");if(looksAuthFailure(error.message))error.code="GOOGLE_AUTH_REQUIRED";throw error;}
  return data;
}
export function selectGoogleSheet(sheets,{sheetId=null,sheetName=null}={}){
  const rows=(sheets||[]).map(item=>item.properties||item);let selected=null,method=null;
  if(sheetId!==null&&sheetId!==undefined){selected=rows.find(item=>Number(item.sheetId)===Number(sheetId))||null;method="sheetId";}
  if(!selected&&sheetName){selected=rows.find(item=>String(item.title)===String(sheetName))||null;method="exact-title";}
  if(!selected&&sheetName){const wanted=normalized(sheetName),matches=rows.filter(item=>normalized(item.title)===wanted);if(matches.length===1){selected=matches[0];method="normalized-unique-title";}else if(matches.length>1){const error=new Error("GOOGLE_SHEETS_TAB_AMBIGUOUS");error.code="GOOGLE_SHEETS_TAB_AMBIGUOUS";throw error;}}
  if(!selected){const error=new Error("GOOGLE_SHEETS_TAB_NOT_FOUND");error.code="GOOGLE_SHEETS_TAB_NOT_FOUND";error.availableSheets=rows.map(item=>({sheetId:item.sheetId,title:item.title}));throw error;}
  return{selected,method};
}
export async function resolveGoogleSheetTarget({spreadsheetId,sheetId=null,sheetName=null}={}){
  await ensureGoogleWorkspace({interactive:true});
  const metadata=await googleSheetMetadata(spreadsheetId),resolved=selectGoogleSheet(metadata.sheets,{sheetId,sheetName}),selected=resolved.selected;
  return{spreadsheetId:String(spreadsheetId),spreadsheetTitle:metadata.properties?.title||null,sheetId:Number(selected.sheetId),sheetName:selected.title,resolutionMethod:resolved.method,metadata};
}
export async function googleSheetRead({spreadsheetId,range}){
  const result=await gapi(["sheets","get",String(spreadsheetId),String(range)]);
  return{...result,values:Array.isArray(result.values)?result.values:[]};
}
export async function googleSheetAppendRows({spreadsheetId,sheetName,rows}){
  if(!Array.isArray(rows)||!rows.length)throw new Error("GOOGLE_SHEET_ROWS_REQUIRED");
  const width=Math.max(...rows.map(row=>Array.isArray(row)?row.length:0),1),range=`${quoteSheet(sheetName)}!A:${colName(width)}`;
  return await gapi(["sheets","append",String(spreadsheetId),range,"--values",JSON.stringify(rows)]);
}
export async function googleSheetUpdateCells({spreadsheetId,range,rows}){
  if(!Array.isArray(rows)||!rows.length)throw new Error("GOOGLE_SHEET_ROWS_REQUIRED");
  return await gapi(["sheets","update",String(spreadsheetId),String(range),"--values",JSON.stringify(rows)]);
}
export async function googleSheetReadback({spreadsheetId,sheetName,startRow,endRow,width}){
  return googleSheetRead({spreadsheetId,range:`${quoteSheet(sheetName)}!A${Number(startRow)}:${colName(Number(width)||1)}${Number(endRow)}`});
}
export async function googleSheetPreflight({spreadsheetId,sheetId=null,sheetName=null}={}){
  const target=await resolveGoogleSheetTarget({spreadsheetId,sheetId,sheetName});
  const read=await googleSheetRead({spreadsheetId,range:`${quoteSheet(target.sheetName)}!A1:ZZ`});
  const values=read.values||[],headers=(values[0]||[]).map(value=>String(value||"").trim());
  if(!headers.some(Boolean)){const error=new Error("GOOGLE_SHEET_HEADERS_REQUIRED");error.code="GOOGLE_SHEET_HEADERS_REQUIRED";throw error;}
  return{ok:true,target,headers,values,rowCount:Math.max(0,values.length-1)};
}
export async function createGoogleSheet({title="ULTRON Lead Export",sheetName="Leads",rows=[]}={}){
  await ensureGoogleWorkspace({interactive:true});
  if(!Array.isArray(rows)||rows.length<1)throw new Error("GOOGLE_SHEET_ROWS_REQUIRED");
  const created=await gapi(["sheets","create","--title",String(title),"--sheet-name",String(sheetName)]);
  const spreadsheetId=created.spreadsheetId||created.spreadsheet_id||created.id;
  if(!spreadsheetId)throw new Error("GOOGLE_SHEET_CREATE_RETURNED_NO_ID");
  const end=colName(Math.max(...rows.map(r=>Array.isArray(r)?r.length:0),1));
  const range=`${sheetName}!A1:${end}${rows.length}`;
  await gapi(["sheets","update",String(spreadsheetId),range,"--values",JSON.stringify(rows)]);
  return{ok:true,status:"created",spreadsheetId,spreadsheetUrl:created.spreadsheetUrl||created.spreadsheet_url||created.url||`https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,title,sheetName,rowCount:rows.length-1};
}
