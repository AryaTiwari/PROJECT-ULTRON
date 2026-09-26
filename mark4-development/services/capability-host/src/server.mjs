import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findCompanyContact, findCompanyContacts } from "./apollo.mjs";
import { searchApolloOrganizations } from "./apollo-organizations.mjs";
import { googleWorkspaceStatus, googleSetClientSecret, googleAuthUrl, googleAuthCode, createGoogleSheet, googleSheetMetadata, resolveGoogleSheetTarget, googleSheetRead, googleSheetAppendRows, googleSheetUpdateCells, googleSheetReadback } from "./workspace.mjs";
import { createReelJob, getReelJob, renderReelJob, inspectReelJob, mediaEngineStatus } from "../../media-engine/src/engine.mjs";

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
{name:"ultron_mission_create",description:"Create complete persistent mission state for a multi-step objective. Cognition owns strategy; this tool stores validated state and evidence boundaries.",inputSchema:{type:"object",required:["objective"],properties:{objective:{type:"string"},originalRequest:{type:"string"},status:{type:"string",enum:["planning","active","blocked","awaiting_approval","paused","completed","failed","cancelled"]},constraints:{type:"object"},completionCriteria:{type:"object"},state:{type:"object"},strategy:{type:"object"},artifacts:{type:"array"},blockers:{type:"array"},approvals:{type:"array"},relatedSessions:{type:"array",items:{type:"string"}},childBranches:{type:"array",items:{type:"string"}},nextAction:{type:"string"}}},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}},
{name:"ultron_mission_get",description:"Read a mission and its evidence by mission id.",inputSchema:{type:"object",required:["missionId"],properties:{missionId:{type:"string"}}},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
{name:"ultron_mission_update",description:"Update mission status, measurable state, strategy, artifacts, blockers, approvals or relationships. Never store private chain-of-thought.",inputSchema:{type:"object",required:["missionId"],properties:{missionId:{type:"string"},originalRequest:{type:["string","null"]},status:{type:"string",enum:["planning","active","blocked","awaiting_approval","paused","completed","failed","cancelled"]},state:{type:"object"},strategy:{type:"object"},nextAction:{type:["string","null"]},completionCriteria:{type:"object"},constraints:{type:"object"},artifacts:{type:"array"},blockers:{type:"array"},approvals:{type:"array"},relatedSessions:{type:"array",items:{type:"string"}},childBranches:{type:"array",items:{type:"string"}}}},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
{name:"ultron_record_evidence",description:"Attach verifiable evidence to an existing mission using URLs, ids, hashes, provider receipts or readbacks.",inputSchema:{type:"object",required:["missionId","kind","source"],properties:{missionId:{type:"string"},kind:{type:"string"},source:{type:"string"},ref:{type:["string","null"]},payload:{type:"object"},verified:{type:"boolean"}}},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}},
{name:"ultron_lead_master_status",description:"Read authoritative Mark 4 lead counts and the remaining verified-company gap for an optional numerical target.",inputSchema:{type:"object",properties:{target:{type:"integer",minimum:0}},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
{name:"ultron_lead_master_search",description:"Search the native Mark 4 lead registry. Use it for dedupe and reuse before fresh company discovery.",inputSchema:{type:"object",properties:{status:{type:"string",enum:["pending","verified","rejected"]},query:{type:"string"},limit:{type:"integer",minimum:1,maximum:1000}},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
{name:"ultron_lead_master_upsert",description:"Create or update one canonical company lead with POC 1 plus optional POC 2 and POC 3. One company equals one lead. LinkedIn verified status requires an inspected active LinkedIn job plus evidence.activeJobVerified=true.",inputSchema:{type:"object",required:["companyName"],properties:{companyName:{type:"string"},companyLink:{type:"string"},jobLink:{type:"string"},jobTitle:{type:"string"},location:{type:"string"},employeeCount:{type:"integer",minimum:0},applicantCount:{type:"integer",minimum:0},source:{type:"string"},verificationStatus:{type:"string",enum:["pending","verified","rejected"]},evidence:{type:"object"},primaryContactName:{type:"string"},primaryContactRole:{type:"string"},primaryContactLinkedin:{type:"string"},primaryContactCompany:{type:"string"},primaryPhone:{type:"string"},primaryEmail:{type:"string"},secondaryContactName:{type:"string"},secondaryContactRole:{type:"string"},secondaryContactLinkedin:{type:"string"},secondaryPhone:{type:"string"},secondaryEmail:{type:"string"},tertiaryContactName:{type:"string"},tertiaryContactRole:{type:"string"},tertiaryContactLinkedin:{type:"string"},tertiaryPhone:{type:"string"},tertiaryEmail:{type:"string"},contactName:{type:"string"},contactRole:{type:"string"},contactLinkedin:{type:"string"},phone:{type:"string"},email:{type:"string"},remarks:{type:"string"}}},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
{name:"ultron_creator_registry_status",description:"Read authoritative creator research counts and the remaining qualified-creator gap for an optional target.",inputSchema:{type:"object",properties:{target:{type:"integer",minimum:0}},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
{name:"ultron_creator_registry_search",description:"Search saved creator candidates before fresh discovery. Missing follower/view metrics remain null rather than guessed.",inputSchema:{type:"object",properties:{status:{type:"string",enum:["candidate","qualified","rejected"]},niche:{type:"string"},query:{type:"string"},limit:{type:"integer",minimum:1,maximum:1000}},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
{name:"ultron_creator_registry_upsert",description:"Create or update one canonical creator. Qualifying a creator requires evidence.profileObserved=true. FollowerCount or avgViews may only be written when evidence.metricsObserved=true.",inputSchema:{type:"object",required:["handle"],properties:{platform:{type:"string"},handle:{type:"string"},profileUrl:{type:"string"},displayName:{type:"string"},niche:{type:"string"},location:{type:"string"},followerCount:{type:"integer",minimum:0},avgViews:{type:"integer",minimum:0},fitScore:{type:"integer",minimum:0,maximum:100},qualificationStatus:{type:"string",enum:["candidate","qualified","rejected"]},evidence:{type:"object"},email:{type:"string"},phone:{type:"string"},outreachStatus:{type:"string"},remarks:{type:"string"}}},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
{name:"ultron_reel_engine_status",description:"Read the lightweight native Mark 4 Reel renderer status and queue state.",inputSchema:{type:"object",properties:{},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
{name:"ultron_reel_create_job",description:"Create a deterministic Elevate OS Reel recipe job from a storyboard. The renderer locks output to 1080x1920, 30fps and the restrained black/blue/white design system.",inputSchema:{type:"object",required:["scenes"],properties:{title:{type:"string"},objective:{type:"string"},audioPath:{type:"string"},scenes:{type:"array",minItems:1,maxItems:12,items:{type:"object"}}}},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}},
{name:"ultron_reel_job_status",description:"Read a native Reel job and its current render state.",inputSchema:{type:"object",required:["jobId"],properties:{jobId:{type:"string"}}},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
{name:"ultron_reel_render_job",description:"Render a prepared Reel job locally through the queue=1 SVG + Sharp + FFmpeg pipeline. This writes only inside the Mark 4 Reel workspace.",inputSchema:{type:"object",required:["jobId"],properties:{jobId:{type:"string"}}},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
{name:"ultron_reel_inspect_job",description:"Inspect the rendered MP4 with ffprobe and return dimensions, duration, codec and size.",inputSchema:{type:"object",required:["jobId"],properties:{jobId:{type:"string"}}},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
{name:"ultron_apollo_search_organizations",description:"Search companies through Apollo Organization Search. This is the company discovery layer; it never searches people, enriches contacts, or reveals phone/email data.",inputSchema:{type:"object",properties:{locations:{type:"array",items:{type:"string"}},employeeMin:{type:["integer","null"],minimum:0},employeeMax:{type:["integer","null"],minimum:0},keywords:{anyOf:[{type:"string"},{type:"array",items:{type:"string"}}]},page:{type:"integer",minimum:1},perPage:{type:"integer",minimum:1,maximum:100}},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
{name:"ultron_google_sheet_metadata",description:"Read spreadsheet metadata and worksheet ids/titles using ULTRON's existing Google OAuth connection.",inputSchema:{type:"object",required:["spreadsheetId"],properties:{spreadsheetId:{type:"string"}}},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
{name:"ultron_google_sheet_resolve_target",description:"Resolve an existing worksheet by sheetId first, then exact title, then a unique normalized title.",inputSchema:{type:"object",required:["spreadsheetId"],properties:{spreadsheetId:{type:"string"},sheetId:{type:["integer","null"]},sheetName:{type:["string","null"]}}},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
{name:"ultron_google_sheet_read",description:"Read an exact range from an existing Google Sheet.",inputSchema:{type:"object",required:["spreadsheetId","range"],properties:{spreadsheetId:{type:"string"},range:{type:"string"}}},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
{name:"ultron_google_sheet_append_rows",description:"Append rows to a verified existing worksheet.",inputSchema:{type:"object",required:["spreadsheetId","sheetName","rows"],properties:{spreadsheetId:{type:"string"},sheetName:{type:"string"},rows:{type:"array",items:{type:"array"}}}},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true}},
{name:"ultron_google_sheet_update_cells",description:"Update an exact range in an existing Google Sheet.",inputSchema:{type:"object",required:["spreadsheetId","range","rows"],properties:{spreadsheetId:{type:"string"},range:{type:"string"},rows:{type:"array",items:{type:"array"}}}},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
{name:"ultron_google_sheet_readback",description:"Read back a just-written row span for verification.",inputSchema:{type:"object",required:["spreadsheetId","sheetName","startRow","endRow","width"],properties:{spreadsheetId:{type:"string"},sheetName:{type:"string"},startRow:{type:"integer",minimum:1},endRow:{type:"integer",minimum:1},width:{type:"integer",minimum:1}}},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}},{name:"ultron_apollo_find_company_contact",description:"Find the single preferred decision maker for an already discovered company using Apollo. Kept for compatibility.",inputSchema:{type:"object",required:["company"],properties:{company:{type:"string"},domain:{type:"string"},location:{type:"string"}}},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
{name:"ultron_apollo_find_company_contacts",description:"Find up to two ranked POC 2/POC 3 contacts inside POC 1's CURRENT company. Exclude POC 1 with excludeLinkedin/excludeName/excludeEmail. Priority: Founder/CEO/Director/Owner, then Co-Founder/Recruiting Head/Manager, then HR Recruiter. Enrichment only, never company discovery.",inputSchema:{type:"object",required:["company"],properties:{company:{type:"string"},domain:{type:"string"},location:{type:"string"},limit:{type:"integer",minimum:1,maximum:2},excludeLinkedin:{type:"string"},excludeName:{type:"string"},excludeEmail:{type:"string"}}},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
{name:"ultron_google_workspace_status",description:"Check whether ULTRON's isolated Google Workspace OAuth is connected for Sheets/Drive.",inputSchema:{type:"object",properties:{},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
{name:"ultron_google_workspace_connect",description:"Open the secure Google Workspace OAuth flow in the local browser, persist a durable refresh token, and return only after the connection is ready.",inputSchema:{type:"object",properties:{},additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true}},
{name:"ultron_google_workspace_set_client_secret",description:"Register a user-provided Google Desktop OAuth client JSON file path for ULTRON's isolated Workspace profile.",inputSchema:{type:"object",required:["path"],properties:{path:{type:"string"}}},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
{name:"ultron_google_workspace_auth_url",description:"Generate the Google OAuth authorization URL for ULTRON. Defaults to Drive + Sheets only.",inputSchema:{type:"object",properties:{services:{type:"string"}}},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true}},
{name:"ultron_google_workspace_auth_code",description:"Finish Google OAuth using the redirected localhost URL or authorization code supplied by the user.",inputSchema:{type:"object",required:["codeOrUrl"],properties:{codeOrUrl:{type:"string"}}},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true}},
{name:"ultron_google_sheet_from_leads",description:"Create a Google Sheet directly from the canonical Mark 4 lead master using the POC layout: POC 1 LinkedIn link + phone/email, then POC 2 and POC 3 name-with-designation + phone/email. Returns structured auth_required without losing research if Google is not connected.",inputSchema:{type:"object",properties:{title:{type:"string"},sheetName:{type:"string"},status:{type:"string",enum:["pending","verified","rejected"]},query:{type:"string"},limit:{type:"integer",minimum:1,maximum:500}}},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true}}
];
async function callTool(name,args={}){
  if(name==="ultron_status")return text(await internal("/internal/status"));
  if(name==="ultron_business_context")return text(businessContext());
  if(name==="ultron_mission_create")return text(await internal("/internal/missions",{method:"POST",body:JSON.stringify(args)}));
  if(name==="ultron_mission_get")return text(await internal(`/internal/missions/${encodeURIComponent(args.missionId)}`));
  if(name==="ultron_mission_update"){const{missionId,...patch}=args;return text(await internal(`/internal/missions/${encodeURIComponent(missionId)}`,{method:"PATCH",body:JSON.stringify(patch)}));}
  if(name==="ultron_record_evidence"){const{missionId,...evidence}=args;return text(await internal(`/internal/missions/${encodeURIComponent(missionId)}/evidence`,{method:"POST",body:JSON.stringify(evidence)}));}
  if(name==="ultron_lead_master_status"){
    const target=args.target===undefined?"":String(args.target);
    return text(await internal("/internal/leads"+(target?"?target="+encodeURIComponent(target):"")));
  }
  if(name==="ultron_lead_master_search"){
    const q=new URLSearchParams();
    if(args.status)q.set("status",args.status);if(args.query)q.set("q",args.query);if(args.limit)q.set("limit",String(args.limit));
    return text(await internal("/internal/leads"+(q.size?"?"+q.toString():"")));
  }
  if(name==="ultron_lead_master_upsert")return text(await internal("/internal/leads",{method:"POST",body:JSON.stringify(args)}));
  if(name==="ultron_creator_registry_status"){const target=args.target===undefined?"":String(args.target);return text(await internal("/internal/creators"+(target?"?target="+encodeURIComponent(target):"")));}
  if(name==="ultron_creator_registry_search"){const q=new URLSearchParams();if(args.status)q.set("status",args.status);if(args.niche)q.set("niche",args.niche);if(args.query)q.set("q",args.query);if(args.limit)q.set("limit",String(args.limit));return text(await internal("/internal/creators"+(q.size?"?"+q.toString():"")));}
  if(name==="ultron_creator_registry_upsert")return text(await internal("/internal/creators",{method:"POST",body:JSON.stringify(args)}));
  if(name==="ultron_reel_engine_status")return text(mediaEngineStatus());
  if(name==="ultron_reel_create_job")return text(createReelJob(args));
  if(name==="ultron_reel_job_status")return text(getReelJob(args.jobId));
  if(name==="ultron_reel_render_job")return text(await renderReelJob(args.jobId));
  if(name==="ultron_reel_inspect_job")return text(await inspectReelJob(args.jobId));
  if(name==="ultron_apollo_search_organizations")return text(await searchApolloOrganizations(args));
  if(name==="ultron_google_sheet_metadata")return text(await googleSheetMetadata(args.spreadsheetId));
  if(name==="ultron_google_sheet_resolve_target")return text(await resolveGoogleSheetTarget(args));
  if(name==="ultron_google_sheet_read")return text(await googleSheetRead(args));
  if(name==="ultron_google_sheet_append_rows")return text(await googleSheetAppendRows(args));
  if(name==="ultron_google_sheet_update_cells")return text(await googleSheetUpdateCells(args));
  if(name==="ultron_google_sheet_readback")return text(await googleSheetReadback(args));
  if(name==="ultron_apollo_find_company_contact")return text(await findCompanyContact(args));
  if(name==="ultron_apollo_find_company_contacts")return text(await findCompanyContacts(args));
  if(name==="ultron_google_workspace_status")return text(await googleWorkspaceStatus());
  if(name==="ultron_google_workspace_connect")return text(await googleWorkspaceConnect());
  if(name==="ultron_google_workspace_set_client_secret")return text(await googleSetClientSecret(args.path));
  if(name==="ultron_google_workspace_auth_url")return text(await googleAuthUrl(args.services||"drive,sheets"));
  if(name==="ultron_google_workspace_auth_code")return text(await googleAuthCode(args.codeOrUrl));
  if(name==="ultron_google_sheet_from_leads"){
    const q=new URLSearchParams();
    q.set("limit",String(Math.max(1,Math.min(500,Number(args.limit)||100))));
    if(args.status)q.set("status",args.status);
    if(args.query)q.set("q",args.query);
    const data=await internal("/internal/leads?"+q.toString());
    const leads=Array.isArray(data.items)?data.items:[];
    const label=(person)=>person?.name?(person.role?person.name+" — "+person.role:person.name):"";
    const rows=[[
      "COMPANY NAME","JOB TITLE","JOB LINK","LOCATION",
      "LINKEDIN LINK","PHONE NUMBER","EMAIL",
      "2ND POC NAME + DESIGNATION","2ND POC PHONE","2ND POC EMAIL",
      "3RD POC NAME + DESIGNATION","3RD POC PHONE","3RD POC EMAIL","REMARKS"
    ],...leads.map(lead=>[
      lead.companyName||"",lead.jobTitle||"",lead.jobLink||"",lead.location||"",
      lead.primaryContact?.linkedin||lead.contact?.linkedin||"",
      lead.primaryContact?.phone||lead.contact?.phone||"",
      lead.primaryContact?.email||lead.contact?.email||"",
      label(lead.secondaryContact),lead.secondaryContact?.phone||"",lead.secondaryContact?.email||"",
      label(lead.tertiaryContact),lead.tertiaryContact?.phone||"",lead.tertiaryContact?.email||"",
      lead.remarks||""
    ])];
    return text(await createGoogleSheet({title:args.title||"ULTRON Lead Research",sheetName:args.sheetName||"Leads",rows}));
  }
  throw new Error(`Unknown tool: ${name}`);
}
function send(id,result,error=null){process.stdout.write(JSON.stringify({jsonrpc:"2.0",id,...(error?{error:{code:-32000,message:error.message||String(error)}}:{result})})+"\n");}
let buffer="";process.stdin.setEncoding("utf8");
process.stdin.on("data",chunk=>{buffer+=chunk;let idx;while((idx=buffer.indexOf("\n"))>=0){const line=buffer.slice(0,idx).trim();buffer=buffer.slice(idx+1);if(!line)continue;let msg;try{msg=JSON.parse(line);}catch{continue;}if(msg.method==="notifications/initialized")continue;Promise.resolve().then(async()=>{if(msg.method==="initialize")return send(msg.id,{protocolVersion:msg.params?.protocolVersion||"2025-06-18",capabilities:{tools:{listChanged:false}},serverInfo:{name:"ultron-mark4",version:"4.0.0-alpha.1"}});if(msg.method==="tools/list")return send(msg.id,{tools});if(msg.method==="tools/call")return send(msg.id,await callTool(msg.params?.name,msg.params?.arguments||{}));if(msg.id!==undefined)send(msg.id,null,new Error("METHOD_NOT_FOUND"));}).catch(error=>msg.id!==undefined&&send(msg.id,null,error));}});
