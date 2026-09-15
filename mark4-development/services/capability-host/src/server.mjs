import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findCompanyContact } from "./apollo.mjs";

const here=path.dirname(fileURLToPath(import.meta.url)),mark4Root=path.resolve(here,"../../..");
const gateway=String(process.env.ULTRON_M4_GATEWAY_URL||"http://127.0.0.1:8787").replace(/\/$/,"");
const internalKey=String(process.env.ULTRON_M4_INTERNAL_KEY||"");
const text=value=>({content:[{type:"text",text:typeof value==="string"?value:JSON.stringify(value,null,2)}]});
async function internal(pathname,options={}){
  if(!internalKey)throw new Error("ULTRON_M4_INTERNAL_KEY is not configured.");
  const r=await fetch(`${gateway}${pathname}`,{...options,headers:{"Content-Type":"application/json","X-Ultron-Internal-Key":internalKey,...(options.headers||{})}});
  const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data?.error||`Gateway HTTP ${r.status}`);return data;
}
function businessContext(){const file=path.join(mark4Root,"hermes","context","ELEVATE.md");return fs.existsSync(file)?fs.readFileSync(file,"utf8"):"Elevate OS context unavailable.";}
const tools=[
{name:"ultron_status",description:"Read ULTRON Mark 4 runtime, mission and model-fabric status.",inputSchema:{type:"object",properties:{},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
{name:"ultron_business_context",description:"Read concise Elevate OS business context and operating priorities.",inputSchema:{type:"object",properties:{},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
{name:"ultron_mission_create",description:"Create persistent mission state for a multi-step objective that must survive restarts or has measurable completion criteria.",inputSchema:{type:"object",required:["objective"],properties:{objective:{type:"string"},constraints:{type:"object"},completionCriteria:{type:"object"},state:{type:"object"},strategy:{type:"object"},nextAction:{type:"string"}}},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}},
{name:"ultron_mission_get",description:"Read a mission and its evidence by mission id.",inputSchema:{type:"object",required:["missionId"],properties:{missionId:{type:"string"}}},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
{name:"ultron_mission_update",description:"Update structured mission status, measurable state, strategy or next action. Never store private chain-of-thought.",inputSchema:{type:"object",required:["missionId"],properties:{missionId:{type:"string"},status:{type:"string"},state:{type:"object"},strategy:{type:"object"},nextAction:{type:["string","null"]},completionCriteria:{type:"object"},constraints:{type:"object"}}},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
{name:"ultron_record_evidence",description:"Attach verifiable evidence to an existing mission using URLs, ids, hashes, provider receipts or readbacks.",inputSchema:{type:"object",required:["missionId","kind","source"],properties:{missionId:{type:"string"},kind:{type:"string"},source:{type:"string"},ref:{type:["string","null"]},payload:{type:"object"},verified:{type:"boolean"}}},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}},
{name:"ultron_apollo_find_company_contact",description:"Find the preferred decision maker for an already discovered company using Apollo. Founder/Director/Owner > Recruiting Head/Manager > HR Recruiter. Enrichment only, never company discovery.",inputSchema:{type:"object",required:["company"],properties:{company:{type:"string"},domain:{type:"string"},location:{type:"string"}}},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}}
];
async function callTool(name,args={}){
  if(name==="ultron_status")return text(await internal("/internal/status"));
  if(name==="ultron_business_context")return text(businessContext());
  if(name==="ultron_mission_create")return text(await internal("/internal/missions",{method:"POST",body:JSON.stringify(args)}));
  if(name==="ultron_mission_get")return text(await internal(`/internal/missions/${encodeURIComponent(args.missionId)}`));
  if(name==="ultron_mission_update"){const{missionId,...patch}=args;return text(await internal(`/internal/missions/${encodeURIComponent(missionId)}`,{method:"PATCH",body:JSON.stringify(patch)}));}
  if(name==="ultron_record_evidence"){const{missionId,...evidence}=args;return text(await internal(`/internal/missions/${encodeURIComponent(missionId)}/evidence`,{method:"POST",body:JSON.stringify(evidence)}));}
  if(name==="ultron_apollo_find_company_contact")return text(await findCompanyContact(args));
  throw new Error(`Unknown tool: ${name}`);
}
function send(id,result,error=null){process.stdout.write(JSON.stringify({jsonrpc:"2.0",id,...(error?{error:{code:-32000,message:error.message||String(error)}}:{result})})+"\n");}
let buffer="";process.stdin.setEncoding("utf8");
process.stdin.on("data",chunk=>{buffer+=chunk;let idx;while((idx=buffer.indexOf("\n"))>=0){const line=buffer.slice(0,idx).trim();buffer=buffer.slice(idx+1);if(!line)continue;let msg;try{msg=JSON.parse(line);}catch{continue;}if(msg.method==="notifications/initialized")continue;Promise.resolve().then(async()=>{if(msg.method==="initialize")return send(msg.id,{protocolVersion:msg.params?.protocolVersion||"2025-06-18",capabilities:{tools:{listChanged:false}},serverInfo:{name:"ultron-mark4",version:"4.0.0-alpha.1"}});if(msg.method==="tools/list")return send(msg.id,{tools});if(msg.method==="tools/call")return send(msg.id,await callTool(msg.params?.name,msg.params?.arguments||{}));if(msg.id!==undefined)send(msg.id,null,new Error("METHOD_NOT_FOUND"));}).catch(error=>msg.id!==undefined&&send(msg.id,null,error));}});
