import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const GOOGLE_AUTH_CONTRACT="google-auth-contract-v1";
export const GOOGLE_WORKSPACE_SCOPES=[
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive"
];

const here=path.dirname(fileURLToPath(import.meta.url));
const mark4Root=path.resolve(here,"../../..");
const projectRoot=path.resolve(mark4Root,"..");
const hermesHome=String(process.env.HERMES_HOME||path.join(mark4Root,".runtime","hermes-home"));
const canonicalClientPath=path.join(hermesHome,"google_client_secret.json");
const canonicalTokenPath=path.join(hermesHome,"google_token.json");
const backupTokenPath=canonicalTokenPath+".bak";
const approvedClientCandidates=[
  path.join(projectRoot,".ultron","credentials","google-sheets-oauth.json"),
  path.join(mark4Root,".runtime","google_client_secret.json")
];
let interactiveAuthorizationInFlight=null;
let lastAuthEvent=null;

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function readJson(file){return JSON.parse(fs.readFileSync(file,"utf8"));}
function safeJson(file){try{return fs.existsSync(file)?readJson(file):null;}catch{return null;}}
function clientFrom(raw){
  const value=raw?.installed||raw?.web||raw;
  if(!value?.client_id||!value?.client_secret)return null;
  return{
    clientId:String(value.client_id),
    clientSecret:String(value.client_secret),
    authUri:String(value.auth_uri||"https://accounts.google.com/o/oauth2/v2/auth"),
    tokenUri:String(value.token_uri||"https://oauth2.googleapis.com/token")
  };
}
function atomicJson(file,value,{backup=true}={}){
  const dir=path.dirname(file);fs.mkdirSync(dir,{recursive:true});
  const temp=path.join(dir,`.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  if(backup&&fs.existsSync(file)){try{const current=readJson(file);if(current&&typeof current==="object")fs.copyFileSync(file,file+".bak");}catch{}}
  fs.writeFileSync(temp,JSON.stringify(value,null,2),{mode:0o600});
  JSON.parse(fs.readFileSync(temp,"utf8"));
  fs.renameSync(temp,file);
  try{fs.chmodSync(file,0o600);}catch{}
}
function recoverClient(){
  const current=safeJson(canonicalClientPath);
  if(clientFrom(current))return{raw:current,client:clientFrom(current),source:"canonical"};
  for(const candidate of approvedClientCandidates){
    const raw=safeJson(candidate),client=clientFrom(raw);
    if(!client)continue;
    atomicJson(canonicalClientPath,raw,{backup:false});
    lastAuthEvent={type:"client-recovered",source:candidate,at:new Date().toISOString()};
    return{raw,client,source:candidate};
  }
  return null;
}
function validToken(token){return Boolean(token&&typeof token==="object"&&(accessOf(token)||refreshOf(token)));}
function loadToken(){
  const primary=safeJson(canonicalTokenPath);
  if(validToken(primary))return primary;
  const backup=safeJson(backupTokenPath);
  if(validToken(backup)){
    atomicJson(canonicalTokenPath,backup,{backup:false});
    lastAuthEvent={type:"token-recovered-from-backup",at:new Date().toISOString()};
    return backup;
  }
  return null;
}
function accessOf(token){return String(token?.access_token||token?.token||"").trim();}
function refreshOf(token){return String(token?.refresh_token||"").trim();}
function scopesOf(token){
  if(Array.isArray(token?.scopes))return token.scopes.map(String);
  return String(token?.scope||"").split(/[\s,]+/).filter(Boolean);
}
function missingScopes(token){const have=new Set(scopesOf(token));return GOOGLE_WORKSPACE_SCOPES.filter(scope=>!have.has(scope));}
function expiryMs(token){
  const direct=Number(token?.expires_at||0);if(Number.isFinite(direct)&&direct>0)return direct;
  const parsed=Date.parse(String(token?.expiry||""));return Number.isFinite(parsed)?parsed:0;
}
function tokenClientCompatible(token,client){return !token?.client_id||String(token.client_id)===String(client.clientId);}
function classifyTokenFailure(data,status){
  const oauth=String(data?.error||"").toLowerCase(),description=String(data?.error_description||"").toLowerCase();
  if(oauth==="invalid_grant"||/expired|revoked|invalid grant/.test(description))return"REFRESH_TOKEN_REJECTED";
  if(oauth==="invalid_client"||oauth==="unauthorized_client")return"CREDENTIALS_INVALID";
  if(oauth==="access_denied")return"AUTH_DENIED";
  if(status===429||status>=500)return"TEMPORARY_NETWORK_FAILURE";
  return"OAUTH_ERROR";
}
async function tokenRequest(client,params){
  let lastError=null;
  for(let attempt=0;attempt<3;attempt++){
    let response;
    try{
      response=await fetch(client.tokenUri,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded",Accept:"application/json"},body:new URLSearchParams(params)});
    }catch(error){
      lastError=Object.assign(new Error("Google OAuth token endpoint could not be reached."),{code:"TEMPORARY_NETWORK_FAILURE",cause:error});
      if(attempt<2){await sleep([500,1500,4000][attempt]);continue;}throw lastError;
    }
    const text=await response.text();let data={};try{data=JSON.parse(text);}catch{}
    if(response.ok)return data;
    const code=classifyTokenFailure(data,response.status);
    const error=Object.assign(new Error(data.error_description||data.error||`Google OAuth HTTP ${response.status}`),{code,status:response.status,googleOAuthError:data.error||null});
    if(code==="TEMPORARY_NETWORK_FAILURE"&&attempt<2){lastError=error;await sleep([500,1500,4000][attempt]);continue;}
    throw error;
  }
  throw lastError||Object.assign(new Error("Google OAuth failed."),{code:"OAUTH_ERROR"});
}
function normalizedStoredToken(previous,fresh,client,{preservePreviousRefresh=true}={}){
  const access=String(fresh.access_token||fresh.token||accessOf(previous)||"");
  const refresh=String(fresh.refresh_token||(preservePreviousRefresh?refreshOf(previous):"")||"");
  const freshScopes=scopesOf(fresh),previousScopes=scopesOf(previous);
  const resolvedScopes=freshScopes.length?freshScopes:(previousScopes.length?previousScopes:GOOGLE_WORKSPACE_SCOPES);
  const seconds=Math.max(60,Number(fresh.expires_in||3600)),expiresAt=Date.now()+seconds*1000;
  return{
    ...(previous||{}),
    ...fresh,
    token:access,
    access_token:access,
    refresh_token:refresh,
    token_uri:client.tokenUri,
    client_id:client.clientId,
    client_secret:client.clientSecret,
    scopes:resolvedScopes,
    scope:String(fresh.scope||resolvedScopes.join(" ")),
    expiry:new Date(expiresAt).toISOString(),
    expires_at:expiresAt,
    authorized_at:new Date().toISOString()
  };
}
async function refreshToken(token,client){
  if(!refreshOf(token))throw Object.assign(new Error("No durable Google refresh token is stored."),{code:"REFRESH_TOKEN_MISSING"});
  const fresh=await tokenRequest(client,{client_id:client.clientId,client_secret:client.clientSecret,refresh_token:refreshOf(token),grant_type:"refresh_token"});
  const stored=normalizedStoredToken(token,fresh,client,{preservePreviousRefresh:true});
  atomicJson(canonicalTokenPath,stored);
  lastAuthEvent={type:"refresh-succeeded",at:new Date().toISOString()};
  return stored;
}
function base64url(value){return Buffer.from(value).toString("base64url");}
function openBrowser(url){
  const command=process.platform==="win32"
    ?["rundll32.exe",["url.dll,FileProtocolHandler",url]]
    :process.platform==="darwin"?["open",[url]]:["xdg-open",[url]];
  try{const child=spawn(command[0],command[1],{detached:true,stdio:"ignore",windowsHide:true});child.unref();return true;}catch{return false;}
}
async function authorizeInteractive({preservePreviousRefresh=true}={}){
  const resolved=recoverClient();
  if(!resolved)throw Object.assign(new Error("Google OAuth client configuration is missing."),{code:"CREDENTIALS_MISSING"});
  const client=resolved.client,previous=loadToken();
  const state=base64url(crypto.randomBytes(24)),verifier=base64url(crypto.randomBytes(48));
  const challenge=base64url(crypto.createHash("sha256").update(verifier).digest());
  let resolveCallback,rejectCallback;
  const callback=new Promise((resolve,reject)=>{resolveCallback=resolve;rejectCallback=reject;});
  const server=http.createServer((req,res)=>{
    try{
      const url=new URL(req.url||"/","http://127.0.0.1");
      const oauthError=url.searchParams.get("error"),returnedState=url.searchParams.get("state"),code=url.searchParams.get("code");
      if(oauthError)throw new Error(`Google authorization failed: ${oauthError}`);
      if(returnedState!==state||!code)throw new Error("Google OAuth callback validation failed.");
      res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});
      res.end("<h2>ULTRON Mark 4 Google Workspace connected.</h2><p>You can close this tab. ULTRON will resume the operation.</p>");
      resolveCallback(code);
    }catch(error){res.writeHead(400,{"Content-Type":"text/plain; charset=utf-8"});res.end(error.message);rejectCallback(error);}
  });
  await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
  const port=server.address().port,redirectUri=`http://127.0.0.1:${port}`;
  const authUrl=new URL(client.authUri);
  authUrl.search=new URLSearchParams({
    client_id:client.clientId,
    redirect_uri:redirectUri,
    response_type:"code",
    scope:GOOGLE_WORKSPACE_SCOPES.join(" "),
    access_type:"offline",
    prompt:"consent",
    include_granted_scopes:"true",
    state,
    code_challenge:challenge,
    code_challenge_method:"S256"
  }).toString();
  lastAuthEvent={type:"interactive-reauthorization-started",at:new Date().toISOString(),authUrl:authUrl.toString()};
  const browserOpened=openBrowser(authUrl.toString());
  if(!browserOpened){server.close();const error=new Error("Google authorization URL could not be opened in the default browser.");error.code="AUTH_BROWSER_OPEN_FAILED";error.authUrl=authUrl.toString();throw error;}
  const timeout=setTimeout(()=>rejectCallback(Object.assign(new Error("Google authorization timed out."),{code:"AUTH_TIMEOUT"})),180000);
  let code;
  try{code=await callback;}finally{clearTimeout(timeout);server.close();}
  const fresh=await tokenRequest(client,{client_id:client.clientId,client_secret:client.clientSecret,code,code_verifier:verifier,redirect_uri:redirectUri,grant_type:"authorization_code"});
  const stored=normalizedStoredToken(previous,fresh,client,{preservePreviousRefresh});
  if(!refreshOf(stored))throw Object.assign(new Error("Google returned no durable refresh token. Revoke the old ULTRON grant and authorize again."),{code:"REFRESH_TOKEN_MISSING"});
  if(missingScopes(stored).length)throw Object.assign(new Error("Google authorization did not grant all required Workspace scopes."),{code:"SCOPE_UPGRADE_REQUIRED",missingScopes:missingScopes(stored)});
  atomicJson(canonicalTokenPath,stored);
  lastAuthEvent={type:"interactive-reauthorization-complete",at:new Date().toISOString()};
  return stored;
}
async function authorizeInteractiveOnce(options={}){
  if(!interactiveAuthorizationInFlight){
    interactiveAuthorizationInFlight=Promise.resolve().then(()=>authorizeInteractive(options)).finally(()=>{interactiveAuthorizationInFlight=null;});
  }
  return interactiveAuthorizationInFlight;
}
async function ensureReady(options={}){
  const interactive=options.interactive===true,forceRefresh=options.forceRefresh===true,forceReauth=options.forceReauth===true;
  const resolved=recoverClient();
  if(!resolved)return{ok:false,state:"CREDENTIALS_MISSING",durable:false,reauthRequired:true};
  const client=resolved.client;
  if(forceReauth){
    if(!interactive)return{ok:false,state:"AUTH_REQUIRED",durable:false,reauthRequired:true};
    const token=await authorizeInteractiveOnce({preservePreviousRefresh:false});
    return{ok:true,state:"READY",durable:true,reauthorized:true,tokenExpiresAt:expiryMs(token)};
  }
  let token=loadToken();
  if(!token){
    if(!interactive)return{ok:false,state:"AUTH_REQUIRED",durable:false,reauthRequired:true};
    token=await authorizeInteractiveOnce({preservePreviousRefresh:false});
    return{ok:true,state:"READY",durable:true,reauthorized:true,tokenExpiresAt:expiryMs(token)};
  }
  if(!tokenClientCompatible(token,client)){
    if(!interactive)return{ok:false,state:"CREDENTIALS_INVALID",durable:false,reauthRequired:true};
    token=await authorizeInteractiveOnce({preservePreviousRefresh:false});
    return{ok:true,state:"READY",durable:true,reauthorized:true,tokenExpiresAt:expiryMs(token)};
  }
  const missing=missingScopes(token);
  if(missing.length){
    if(!interactive)return{ok:false,state:"SCOPE_UPGRADE_REQUIRED",durable:Boolean(refreshOf(token)),reauthRequired:true,missingScopes:missing};
    token=await authorizeInteractiveOnce({preservePreviousRefresh:Boolean(refreshOf(token))});
    return{ok:true,state:"READY",durable:true,reauthorized:true,tokenExpiresAt:expiryMs(token)};
  }
  const accessValid=Boolean(accessOf(token)&&expiryMs(token)>Date.now()+60000);
  if(accessValid&&!forceRefresh){
    return{ok:true,state:refreshOf(token)?"READY":"NON_DURABLE",durable:Boolean(refreshOf(token)),reauthRequired:false,tokenExpiresAt:expiryMs(token)};
  }
  if(refreshOf(token)){
    try{
      token=await refreshToken(token,client);
      return{ok:true,state:"READY",durable:true,refreshed:true,reauthRequired:false,tokenExpiresAt:expiryMs(token)};
    }catch(error){
      if(error.code==="TEMPORARY_NETWORK_FAILURE")return Promise.reject(error);
      if(!["REFRESH_TOKEN_REJECTED","CREDENTIALS_INVALID","AUTH_DENIED"].includes(String(error.code)))throw error;
      lastAuthEvent={type:"refresh-rejected",code:error.code,at:new Date().toISOString()};
      if(!interactive)return{ok:false,state:error.code==="REFRESH_TOKEN_REJECTED"?"REFRESH_TOKEN_REJECTED":"AUTH_REQUIRED",durable:false,reauthRequired:true};
      token=await authorizeInteractiveOnce({preservePreviousRefresh:false});
      return{ok:true,state:"READY",durable:true,reauthorized:true,tokenExpiresAt:expiryMs(token)};
    }
  }
  if(accessValid)return{ok:true,state:"NON_DURABLE",durable:false,reauthRequired:true,tokenExpiresAt:expiryMs(token)};
  if(!interactive)return{ok:false,state:"AUTH_REQUIRED",durable:false,reauthRequired:true};
  token=await authorizeInteractiveOnce({preservePreviousRefresh:false});
  return{ok:true,state:"READY",durable:true,reauthorized:true,tokenExpiresAt:expiryMs(token)};
}
function status(){
  const resolved=recoverClient(),token=loadToken(),client=resolved?.client||null;
  const missing=token?missingScopes(token):GOOGLE_WORKSPACE_SCOPES;
  const compatible=Boolean(!token||!client||tokenClientCompatible(token,client));
  const accessValid=Boolean(token&&accessOf(token)&&expiryMs(token)>Date.now()+60000);
  let state="AUTH_REQUIRED";
  if(!resolved)state="CREDENTIALS_MISSING";
  else if(token&&!compatible)state="CREDENTIALS_INVALID";
  else if(token&&missing.length)state="SCOPE_UPGRADE_REQUIRED";
  else if(token&&accessValid&&refreshOf(token))state="READY";
  else if(token&&accessValid)state="NON_DURABLE";
  else if(token&&refreshOf(token))state="REFRESH_REQUIRED";
  return{contractVersion:GOOGLE_AUTH_CONTRACT,state,authenticated:state==="READY"||state==="NON_DURABLE",durable:Boolean(token&&refreshOf(token)&&compatible&&!missing.length),clientPresent:Boolean(resolved),tokenPresent:Boolean(token),tokenExpiresAt:token?expiryMs(token):null,hasRefreshToken:Boolean(token&&refreshOf(token)),missingScopes:missing,canonicalClientPath,canonicalTokenPath,backupTokenPath,hermesHome,mark4Root,projectRoot,lastAuthEvent};
}

export const mark4GoogleAuth={
  mark4Root,projectRoot,hermesHome,canonicalClientPath,canonicalTokenPath,backupTokenPath,
  requiredScopes:GOOGLE_WORKSPACE_SCOPES,
  recoverClient,loadToken,status,ensureReady,authorizeInteractive:authorizeInteractiveOnce
};
