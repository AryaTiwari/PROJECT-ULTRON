import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");

function loadEnv(file){
  if(!fs.existsSync(file))return;
  for(const line of fs.readFileSync(file,"utf8").split(/\r?\n/)){
    const trimmed=line.trim();
    if(!trimmed||trimmed.startsWith("#"))continue;
    const index=trimmed.indexOf("=");
    if(index<1)continue;
    const key=trimmed.slice(0,index).trim();
    const value=trimmed.slice(index+1).trim().replace(/^[\"']|[\"']$/g,"");
    if(process.env[key]===undefined)process.env[key]=value;
  }
}

loadEnv(path.resolve(root,"..",".env"));
loadEnv(path.join(root,".env"));
loadEnv(path.join(root,".runtime","secrets.env"));

const host=String(process.env.OMNIROUTE_HOST||"127.0.0.1");
const port=Number(process.env.OMNIROUTE_PORT||20128);
const baseUrl=String(process.env.OMNIROUTE_BASE_URL||`http://${host}:${port}/v1`).replace(/\/+$/,"");
const runtimeDir=path.join(root,".runtime","omniroute");
const logFile=path.join(runtimeDir,"omniroute.log");

function open(){
  return new Promise(resolve=>{
    const socket=net.createConnection({host,port});
    const done=value=>{try{socket.destroy();}catch{}resolve(value);};
    socket.once("connect",()=>done(true));socket.once("error",()=>done(false));socket.setTimeout(450,()=>done(false));
  });
}
async function models(){
  const headers={Accept:"application/json"};
  const key=String(process.env.OMNIROUTE_API_KEY||process.env.OMNIROUTE_ENDPOINT_KEY||process.env.ULTRON_OMNIROUTE_API_KEY||"").trim();
  if(key)headers.Authorization="Bearer "+key;
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),1800);
  try{
    const response=await fetch(baseUrl+"/models",{headers,signal:controller.signal,cache:"no-store"});
    return response.ok;
  }catch{return false;}
  finally{clearTimeout(timer);}
}
function candidates(){
  const home=os.homedir();
  return [
    process.env.OMNIROUTE_DIR,
    path.join(home,"Downloads","OmniRoute-release-v3.8.51","OmniRoute-release-v3.8.51"),
    path.join(home,"Downloads","OmniRoute-release-v3.8.51"),
    path.join(root,".runtime","vendor","omniroute")
  ].filter(Boolean);
}
function locate(){
  for(const dir of candidates()){
    const entry=path.join(dir,"scripts","dev","run-next.mjs");
    if(fs.existsSync(entry))return{dir,entry};
  }
  return null;
}
function tail(file,lines=120){\n  try{return fs.readFileSync(file,"utf8").split(/\\r?\\n/).slice(-lines).join("\n").trim();}catch{return "";}\n}\nfunction stopStaleListener(){\n  if(process.platform!=="win32")return;\n  const script="$p=Get-NetTCPConnection -LocalPort "+port+" -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; if($p){$p|ForEach-Object{Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue}}";\n  spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",script],{cwd:root,env:process.env,stdio:["ignore","ignore","ignore"],shell:false,windowsHide:true});\n}
async function waitReady(state,timeoutMs=90000){
  const started=Date.now();
  let nextNotice=10000;
  while(Date.now()-started<timeoutMs){
    if(state.exited)return false;
    try{if(await open()&&await models())return true;}catch{}
    const elapsed=Date.now()-started;
    if(elapsed>=nextNotice){console.log("OmniRoute still starting... "+Math.round(elapsed/1000)+"s");nextNotice+=10000;}
    await new Promise(r=>setTimeout(r,350));
  }
  return false;
}

if(await open()){\n  if(await models()){console.log(`OmniRoute already ready at ${baseUrl}`);process.exit(0);}\n  console.warn(`Stale OmniRoute listener detected on ${host}:${port}; replacing it silently.`);\n  stopStaleListener();\n  await new Promise(r=>setTimeout(r,500));\n}

const found=locate();
if(!found){
  console.error("OmniRoute is not running and no existing installation was found.");
  console.error("Set OMNIROUTE_DIR in mark4-development/.env to your OmniRoute installation directory.");
  console.error("Expected that directory to contain scripts/dev/run-next.mjs.");
  process.exit(1);
}

fs.mkdirSync(runtimeDir,{recursive:true});
try{fs.writeFileSync(logFile,"","utf8");}catch{}
const log=fs.openSync(logFile,"a");
const memoryMb=Number(process.env.OMNIROUTE_MEMORY_MB||2048);
const env={...process.env,PORT:String(port),HOST:host,OMNIROUTE_USE_TURBOPACK:process.platform==="win32"?"0":String(process.env.OMNIROUTE_USE_TURBOPACK||"1"),OMNIROUTE_MEMORY_MB:String(memoryMb),OMNIROUTE_SKIP_DB_HEALTHCHECK:process.env.OMNIROUTE_SKIP_DB_HEALTHCHECK||"1",NEXT_TELEMETRY_DISABLED:"1"};
if(!env.OMNIROUTE_API_KEY)env.OMNIROUTE_API_KEY=env.OMNIROUTE_ENDPOINT_KEY||env.ULTRON_OMNIROUTE_API_KEY||"";

console.log("Starting existing OmniRoute installation:",found.dir);
console.log("OmniRoute log:",logFile);
console.log("OmniRoute launch mode: hidden canonical run-next wrapper");
const state={exited:false,code:null,signal:null,error:null};
const child=spawn(process.execPath,[`--max-old-space-size=${memoryMb}`,found.entry,"dev"],{cwd:found.dir,env,detached:false,windowsHide:true,shell:false,stdio:["ignore",log,log]});
child.once("error",error=>{state.error=error?.message||String(error);state.exited=true;});
child.once("exit",(code,signal)=>{state.code=code;state.signal=signal;state.exited=true;});
child.unref();
try{fs.closeSync(log);}catch{}

if(!(await waitReady(state))){
  const output=tail(logFile);
  if(output)console.error("\nLast OmniRoute output:\n"+output);
  const detail=state.error?state.error:(state.exited?("launcher exited with "+(state.signal?("signal "+state.signal):("code "+state.code))):"startup timeout");
  console.error("OmniRoute failed to become ready: "+detail+". See "+logFile);
  process.exit(1);
}
console.log("OmniRoute ready at "+baseUrl);
