import { managedCredentialPresent,storeCredential,deleteCredential } from "../../capability-host/src/secure-credentials.mjs";
import { googleWorkspaceStatus,googleWorkspaceConnect } from "../../capability-host/src/workspace.mjs";

export const INTEGRATION_STATUSES=Object.freeze(["CONNECTED","NOT_CONNECTED","AUTH_REQUIRED","INVALID","DEGRADED","RATE_LIMITED","UNAVAILABLE"]);
const allowed=new Map([
 ["apollo",["APOLLO_API_KEY"]],["freellmapi",["FREELLMAPI_KEY","FREE_LLM_API_KEY"]],["gemini",["GEMINI_API_KEY","GEMINI_APY_KEY","GEMINI_API_KEY2","GOOGLE_API_KEY"]],
 ["grok",["GROK_API_KEY","GROK_API_KEY2","XAI_API_KEY"]],["nvidia",["NVIDIA_API_KEY"]],["supabase",["SUPABASE_SERVICE_ROLE_KEY","SUPABASE_ANON_KEY"]],
 ["email",["RESEND_API_KEY","SMTP_PASSWORD"]],["reel-assets",["PEXELS_API_KEY","UNSPLASH_ACCESS_KEY"]],["custom-api",["ULTRON_CUSTOM_API_KEY"]]
]);
const runtimeState=new Map();let cache={at:0,items:null};
export function setRuntimeIntegrationState(id,status,detail){runtimeState.set(id,{status,detail,at:Date.now()});cache.at=0;}
const meta={
 google:{name:"Google Workspace",kind:"OAuth",capabilities:["Sheets metadata","Worksheet reads and writes","Drive files"],scopes:["Google Sheets","Google Drive"]},
 apollo:{name:"Apollo",kind:"API key",capabilities:["Company discovery","Decision-maker search","Contact enrichment"],scopes:["Organizations","People"]},
 linkedin:{name:"LinkedIn",kind:"Authenticated browser",capabilities:["Company research","Job verification"],scopes:["Read-only account session"]},
 github:{name:"GitHub",kind:"CLI / token",capabilities:["Repository context","Commits","Pull requests"],scopes:["Current repository"]},
 browser:{name:"Browser & Screen Context",kind:"Browser permission",capabilities:["Shared-tab identity","Screen capture","Page context"],scopes:["Explicitly shared surface only"]},
 freellmapi:{name:"FreeLLMAPI",kind:"API key",capabilities:["Conversation fallback"],scopes:["Model inference"]},
 gemini:{name:"Gemini",kind:"API key",capabilities:["Conversation","Reasoning","Vision"],scopes:["Model inference"]},
 grok:{name:"Grok / xAI",kind:"API key",capabilities:["Conversation","Reasoning"],scopes:["Model inference"]},
 nvidia:{name:"NVIDIA",kind:"API key",capabilities:["Model inference","Independent review"],scopes:["NIM endpoints"]},
 supabase:{name:"Supabase",kind:"API key",capabilities:["Database","Auth","Storage"],scopes:["Configured project"]},
 email:{name:"Email",kind:"API key / SMTP",capabilities:["Drafting","Transactional delivery"],scopes:["Configured sender"]},
 "reel-assets":{name:"Reel Asset Sources",kind:"API keys",capabilities:["Licensed stock assets","Asset provenance"],scopes:["Configured providers"]},
 "custom-api":{name:"Custom API",kind:"Encrypted local credential",capabilities:["User-defined API calls","Controlled skill proposal"],scopes:["Configured base URL"]}
};
function envPresent(id){return (allowed.get(id)||[]).some(name=>Boolean(String(process.env[name]||"").trim()));}
function statusFor(id){const runtime=runtimeState.get(id);if(runtime)return runtime.status;if(id==="github")return process.env.GITHUB_TOKEN||process.env.GH_TOKEN?"CONNECTED":"DEGRADED";if(["browser","linkedin"].includes(id))return"AUTH_REQUIRED";return envPresent(id)||managedCredentialPresent(id)?"CONNECTED":"NOT_CONNECTED";}
export async function listIntegrations(){if(cache.items&&Date.now()-cache.at<15000)return cache.items;const google=await googleWorkspaceStatus().catch(e=>({status:"temporary_failure",detail:e.message}));const items=Object.entries(meta).map(([id,item])=>{let status=statusFor(id),detail="Configuration is not present.";if(id==="google"){status=google.authenticated?"CONNECTED":google.status==="temporary_failure"?"DEGRADED":"AUTH_REQUIRED";detail=google.detail||"Google authorization is required.";}else if(status==="CONNECTED")detail=managedCredentialPresent(id)?"Encrypted credential is stored for this Windows user.":"Configured through the process environment.";else if(id==="github"&&status==="DEGRADED")detail="Repository context is available; authenticated remote actions require GitHub CLI or a token.";else if(id==="browser")detail="Permission is granted only after Share screen/tab is pressed in Chat.";else if(id==="linkedin")detail="Connect through a user-visible authenticated browser session.";const live=runtimeState.get(id);if(live?.detail)detail=live.detail;return{id,...item,status,detail,configured:status==="CONNECTED",managed:managedCredentialPresent(id),actions:[status==="CONNECTED"?"Disconnect":"Connect",status==="CONNECTED"?"Test":"Configure","View capabilities","View scopes",...(id==="custom-api"?["Propose skill"]:[])]};});cache={at:Date.now(),items};return items;}
export async function integrationAction(id,action,input={}){if(!meta[id])throw new Error("INTEGRATION_NOT_SUPPORTED");const verb=String(action||"").toLowerCase();if(id==="google"&&["connect","reconnect"].includes(verb)){const result=await googleWorkspaceConnect();return{ok:Boolean(result?.ok),id,status:result?.ok?"CONNECTED":"AUTH_REQUIRED"};}if(verb==="configure"){storeCredential(id,input.secret);cache.at=0;return{ok:true,id,status:"CONNECTED",stored:"windows-current-user-dpapi"};}if(verb==="disconnect"){deleteCredential(id);cache.at=0;return{ok:true,id,status:envPresent(id)?"CONNECTED":"NOT_CONNECTED",environmentManaged:envPresent(id)};}if(verb==="test"){if(id==="google"){const s=await googleWorkspaceStatus();return{ok:Boolean(s.authenticated),id,status:s.authenticated?"CONNECTED":"AUTH_REQUIRED",detail:s.detail||null};}const present=envPresent(id)||managedCredentialPresent(id);return{ok:present,id,status:present?"CONNECTED":"NOT_CONNECTED",detail:present?"Credential is readable; no paid provider request was made.":"Configure a credential first."};}throw new Error("INTEGRATION_ACTION_NOT_SUPPORTED");}
