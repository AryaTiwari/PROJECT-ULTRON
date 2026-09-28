import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { config, uiDist, runtimeRoot } from "./config.mjs";
import { hermes } from "./hermes.mjs";
import { createMission,getMission,listMissions,updateMission,addEvidence,listEvidence,addEvent,listEvents,recordModelMetric,recordBranch,getBranch,renameBranch,listBranches,upsertLead,getLead,listLeads,leadStats,upsertCreator,getCreator,listCreators,creatorStats } from "./db.mjs";
import { rankModels,fabricStatus,classifyModelError } from "./model-fabric.mjs";
import { subscribe,publish } from "./event-hub.mjs";
import { unwrapList, unwrapSession } from "./hermes-contract.mjs";
import { createNestedBranch } from "./branching.mjs";
import { normalizeRunEvent, isTerminalRunEvent } from "./run-events.mjs";
import { compileCommand } from "./command-control-plane.mjs";
import { createApolloCompanyMissionRunner } from "./apollo-company-mission.mjs";
import { createApolloContactMissionRunner } from "./apollo-contact-mission.mjs";
import { systemOverview } from "./system-overview.mjs";
import { listIntegrations,integrationAction,setRuntimeIntegrationState } from "./integrations.mjs";
import { visibleMissions,attentionFor } from "./attention.mjs";
import { setGoogleWorkspaceAuthEventSink } from "../../capability-host/src/workspace.mjs";

setGoogleWorkspaceAuthEventSink((type,data)=>publish(type,data));

const json=(res,status,value)=>{res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});res.end(JSON.stringify(value));};
const body=(req,maxBytes=2_000_000)=>new Promise((resolve,reject)=>{let raw="",settled=false;req.setEncoding("utf8");req.on("data",c=>{if(settled)return;raw+=c;if(Buffer.byteLength(raw,"utf8")>maxBytes){settled=true;const error=new Error("REQUEST_TOO_LARGE");error.status=413;reject(error);req.destroy();}});req.on("end",()=>{if(settled)return;try{resolve(raw?JSON.parse(raw):{});}catch(e){reject(e);}});req.on("error",reject);});
const parts=pathname=>pathname.split("/").filter(Boolean);
const internal=req=>Boolean(config.internalKey)&&req.headers["x-ultron-internal-key"]===config.internalKey;
const sessionIdOf=session=>String(session?.id||session?.session_id||"");
function decorateSessions(sessions){
  const metadata=new Map(listBranches().map(item=>[item.sessionId,item]));
  return unwrapList(sessions).map(session=>{
    const id=sessionIdOf(session),branch=metadata.get(id);
    return branch?{...session,title:branch.title||session.title,parent_session_id:branch.parentSessionId,branch_metadata:branch}:session;
  });
}
function saveAttachment(input={}){
  const name=String(input.name||"attachment").replace(/[^a-zA-Z0-9._ -]+/g,"_").slice(0,120)||"attachment";
  const type=String(input.type||"application/octet-stream").slice(0,120);
  const encoded=String(input.data||"").replace(/^data:[^;]+;base64,/,"");
  const bytes=Buffer.from(encoded,"base64");
  if(!bytes.length)throw Object.assign(new Error("ATTACHMENT_EMPTY"),{status:400});
  if(bytes.length>10*1024*1024)throw Object.assign(new Error("ATTACHMENT_TOO_LARGE"),{status:413});
  const dir=path.join(runtimeRoot,"uploads");fs.mkdirSync(dir,{recursive:true});
  const id=`attachment-${Date.now()}-${Math.random().toString(36).slice(2,9)}`;
  const target=path.join(dir,`${id}-${name}`);fs.writeFileSync(target,bytes);
  return{id,name,type,size:bytes.length,path:target,createdAt:new Date().toISOString()};
}


function cors(req,res){const origin=req.headers.origin;if(origin&&/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(origin)){res.setHeader("Access-Control-Allow-Origin",origin);res.setHeader("Vary","Origin");}res.setHeader("Access-Control-Allow-Headers","Content-Type, X-Ultron-Internal-Key");res.setHeader("Access-Control-Allow-Methods","GET,POST,PATCH,OPTIONS");}
function serveStatic(pathname,res){
  if(!fs.existsSync(uiDist)) return false;
  const requested=pathname==="/"? "index.html":pathname.replace(/^\//,"");
  let target=path.resolve(uiDist,requested);
  const root=path.resolve(uiDist);
  if(target!==root&&!target.startsWith(root+path.sep)) return false;
  if(!fs.existsSync(target)||fs.statSync(target).isDirectory()) target=path.join(uiDist,"index.html");
  if(!fs.existsSync(target)) return false;
  const ext=path.extname(target);const types={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".svg":"image/svg+xml"};
  res.writeHead(200,{"Content-Type":types[ext]||"application/octet-stream","Cache-Control":ext===".html"?"no-cache":"public, max-age=3600"});
  fs.createReadStream(target).pipe(res);return true;
}
function parseSse(block){
  let type="message";const data=[];
  for(const line of block.split(/\r?\n/)){if(line.startsWith("event:"))type=line.slice(6).trim();else if(line.startsWith("data:"))data.push(line.slice(5).trim());}
  if(!data.length)return null;const raw=data.join("\n");try{return{type,data:JSON.parse(raw)};}catch{return{type,data:{raw}};}
}
const UI_TELEMETRY=new Set(["voice.listening","voice.transcribing","voice.transcribed","voice.speaking","voice.idle","voice.error","screen.shared","screen.stopped","screen.permission_denied"]);
function runtimeStatus(health,modelFabric=fabricStatus()){
  const routes=Array.isArray(modelFabric)?modelFabric:[];
  const modelReady=routes.some(route=>route?.configured&&!route?.cooling);
  const hermesReady=Boolean(health?.ok);
  return{ok:true,status:hermesReady&&modelReady?"online":"degraded",gateway:{ok:true,host:config.host,port:config.port},hermes:{ok:hermesReady,status:Number(health?.status||0),error:health?.error||null},model:{ok:modelReady,readyRoutes:routes.filter(route=>route?.configured&&!route?.cooling).length},checkedAt:new Date().toISOString()};
}
function createMissionObserved(input){const mission=createMission(input);publish("mission.started",{missionId:mission.id,objective:mission.objective,status:mission.status,state:mission.state});return mission;}
function updateMissionObserved(id,patch){const mission=updateMission(id,patch);if(mission)publish(mission.status==="completed"?"mission.completed":"mission.updated",{missionId:mission.id,objective:mission.objective,status:mission.status,state:mission.state,nextAction:mission.nextAction});return mission;}
function addEvidenceObserved(input){const evidence=addEvidence(input);publish("evidence.recorded",{missionId:input.missionId,kind:evidence.kind,source:evidence.source,verified:evidence.verified});return evidence;}
const nativeMissions=createApolloCompanyMissionRunner({db:{createMission,getMission,updateMission,addEvent},publish});
const nativeContacts=createApolloContactMissionRunner({db:{createMission,getMission,updateMission,addEvent,listLeads,upsertLead,getLead},publish});
const normalizeLabel=value=>String(value||"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
function nativeChatResponse(res,result){
  res.writeHead(200,{"Content-Type":"text/event-stream; charset=utf-8","Cache-Control":"no-cache, no-transform","Connection":"keep-alive","X-Accel-Buffering":"no"});
  res.write(`event: run.started\ndata: ${JSON.stringify({run_id:result.runId,native:true,operation:result.operation||"apollo-company-discovery"})}\n\n`);
  if(result.ok){res.write(`event: approval.request\ndata: ${JSON.stringify({run_id:result.runId,request_id:result.requestId,kind:result.operation==="apollo-contact-enrichment"?"Apollo Contact Enrichment":"Apollo Organization Search",description:result.message,choices:["once","deny"],native:true})}\n\n`);}
  else if(result.mission?.state?.attentionState){const message=result.mission.nextAction||result.error||"This mission needs your input.";res.write(`event: assistant.delta\ndata: ${JSON.stringify({delta:message,native:true,attentionState:result.mission.state.attentionState,pendingParameter:result.mission.state.pendingParameter||null})}\n\n`);res.write(`event: run.completed\ndata: ${JSON.stringify({run_id:result.runId,output:message,native:true,attentionState:result.mission.state.attentionState})}\n\n`);}else{res.write(`event: run.failed\ndata: ${JSON.stringify({run_id:result.runId,error:result.error||result.mission?.state?.error||"Native mission preflight failed",native:true})}\n\n`);}
  res.end();
}
function nativeText(res,{runId="native-control",text,event="run.completed",data={}}={}){res.writeHead(200,{"Content-Type":"text/event-stream; charset=utf-8","Cache-Control":"no-cache, no-transform","Connection":"keep-alive"});res.write(`event: run.started\ndata: ${JSON.stringify({run_id:runId,native:true})}\n\n`);res.write(`event: assistant.delta\ndata: ${JSON.stringify({delta:text,native:true,...data})}\n\n`);res.write(`event: ${event}\ndata: ${JSON.stringify({run_id:runId,native:true,output:text,...data})}\n\n`);return res.end();}
async function routeChat(req,res,sessionId,input){
  const activeMission=input?.missionId?getMission(input.missionId):null,text=String(input?.input||"").trim(),context={...(input?.context||{}),activeMissionId:input?.missionId||null};
  if(activeMission?.state?.pendingParameter&&nativeContacts.isNativeRun(activeMission.id)){
    const pending=activeMission.state.pendingParameter,option=(pending.options||[]).find(x=>normalizeLabel(x.title)===normalizeLabel(text)||String(x.sheetId)===text),screenUrl=String(context?.page?.url||context?.currentUrl||"");
    const result=await nativeContacts.provideParameter(activeMission.id,{key:pending.key,value:pending.key==="spreadsheet_url"?(screenUrl||text):(option?.title||text),sheetId:option?.sheetId});
    if(result?.requestId)return nativeChatResponse(res,{...result,operation:"apollo-contact-enrichment"});
    return nativeText(res,{runId:activeMission.id,text:result?.mission?.nextAction||"Parameter saved. The same mission is continuing.",data:{missionId:activeMission.id}});
  }
  const intent=compileCommand(text,context);
  if(intent.domain==="mission-control"){
    const m=getMission(intent.missionId);if(!m)return nativeText(res,{runId:intent.missionId,text:"That mission is no longer available.",event:"run.failed"});
    if(intent.operation==="pause"){updateMissionObserved(m.id,{status:"paused",state:{attentionState:"BLOCKED"},nextAction:"Resume when ready."});return nativeText(res,{runId:m.id,text:"Paused the mission at its saved checkpoint."});}
    if(intent.operation==="cancel"){updateMissionObserved(m.id,{status:"cancelled",state:{attentionState:null},nextAction:null});return nativeText(res,{runId:m.id,text:"Cancelled the mission."});}
    if(intent.operation==="resume"){if(nativeContacts.isNativeRun(m.id))await nativeContacts.resume(m.id);else if(nativeMissions.isNativeRun(m.id))await nativeMissions.resume(m.id);else updateMissionObserved(m.id,{status:"active",state:{attentionState:null},blockers:[]});return nativeText(res,{runId:m.id,text:"Resumed the mission from its saved checkpoint."});}
    if(intent.operation==="skip"){updateMissionObserved(m.id,{state:{skipRequested:true,skipRequestedAt:new Date().toISOString()}});return nativeText(res,{runId:m.id,text:"Skip requested. The active runner will preserve evidence and move to the next safe item."});}
    if(intent.operation==="open-output"){const o=(m.outputs||m.artifacts||[]).at(-1);return nativeText(res,{runId:m.id,text:o?.url?`Latest output: ${o.url}`:"This mission does not have an openable output yet."});}
    const metrics=m.state?.metrics||{},p=m.progress||m.state?.progress;return nativeText(res,{runId:m.id,text:`${m.objective}\nStatus: ${m.status}. Stage: ${p?.currentStage||"unknown"}. Processed: ${metrics.processed??p?.completed??0}${p?.total!=null?`/${p.total}`:""}. Full matches: ${metrics.fullMatch??0}. Partial matches: ${metrics.partialMatch??0}. No matches: ${metrics.noMatch??0}. Requests: ${metrics.requests??0}. Remaining: ${metrics.remaining??"unknown"}.`});
  }
  if(intent.domain==="apollo-contact-enrichment"&&intent.operation==="resume"){
    publish("request.received",{sessionId,native:true});const result=await nativeContacts.resume(intent.missionId);
    res.writeHead(200,{"Content-Type":"text/event-stream; charset=utf-8","Cache-Control":"no-cache"});
    res.write("event: run.started\ndata: "+JSON.stringify({run_id:intent.missionId,native:true,operation:"apollo-contact-enrichment-resume"})+"\n\n");
    res.write("event: assistant.delta\ndata: "+JSON.stringify({delta:"Resumed "+intent.missionId+" from its saved contact checkpoint.",native:true})+"\n\n");return res.end();
  }
  if(intent.domain==="apollo-contact-enrichment"){
    publish("request.received",{sessionId,native:true});const result=await nativeContacts.start({sessionId,intent});result.operation="apollo-contact-enrichment";return nativeChatResponse(res,result);
  }
  if(intent.domain==="apollo-company-discovery"&&intent.operation==="resume"){
    publish("request.received",{sessionId,characters:String(input?.input||"").length,native:true});
    const result=await nativeMissions.resume(intent.missionId);res.writeHead(200,{"Content-Type":"text/event-stream; charset=utf-8","Cache-Control":"no-cache, no-transform","Connection":"keep-alive"});res.write(`event: run.started\ndata: ${JSON.stringify({run_id:intent.missionId,native:true,operation:"apollo-company-discovery-resume"})}\n\n`);res.write(`event: assistant.delta\ndata: ${JSON.stringify({delta:`Resumed ${intent.missionId} from its saved checkpoint.`,native:true})}\n\n`);return res.end();
  }
  if(intent.domain==="apollo-company-discovery"&&intent.operation==="apollo-company-discovery"){
    publish("request.received",{sessionId,characters:String(input?.input||"").length,native:true});
    const result=await nativeMissions.start({sessionId,intent});return nativeChatResponse(res,result);
  }
  return proxyChat(req,res,sessionId,input);
}
function skillForTool(data={}){
  const raw=String(data.tool_name||data.tool||data.name||data.display_name||"").toLowerCase();
  if(/apollo|lead|contact|enrich/.test(raw))return"Apollo Lead Intelligence";
  if(/google|sheet|drive|workspace/.test(raw))return"Google Workspace Operations";
  if(/linkedin/.test(raw))return"LinkedIn Company Research";
  if(/creator|instagram/.test(raw))return"Elevate Creator Research";
  if(/github|code|terminal|file|patch|build/.test(raw))return"Coding & Publishing";
  if(/reel|ffmpeg|video|media|image/.test(raw))return"Media Production";
  if(/memory|context/.test(raw))return"Memory & Context";
  if(/web|browser|search|research/.test(raw))return"Adaptive Research";
  return"Hermes Native Capability";
}
async function proxyChat(req,res,sessionId,input){
  const role=String(input.role||"cognition"),missionId=input.missionId||null;
  publish("request.received",{sessionId,missionId,role,characters:String(input.input||"").length});
  const basePayload={input:String(input.input||""),session_id:sessionId};
  const started=Date.now(),controller=new AbortController();
  res.on("close",()=>{if(!res.writableEnded)controller.abort();});

  const candidates=rankModels(role).slice(0,3);
  let selected=null,accepted=null,lastError=null;
  for(const candidate of candidates){
    const payload={...basePayload};
    if(candidate.model) payload.model=candidate.model;
    if(candidate.provider) payload.provider=candidate.provider;
    const attemptStarted=Date.now();
    try{
      accepted=await hermes.createRun(payload);
      selected=candidate;
      break;
    }catch(error){
      lastError=error;
      const classified=classifyModelError(error);
      recordModelMetric(candidate.id,{success:false,latencyMs:Date.now()-attemptStarted,errorClass:classified.errorClass,errorMessage:error.message,cooldownMs:classified.cooldownMs});
      publish("model.route_failed",{sessionId,missionId,route:candidate.id,provider:candidate.provider||"Hermes",model:candidate.model||null,errorClass:classified.errorClass,error:error.message});
    }
  }
  if(!accepted||!selected){
    const error=lastError||new Error("NO_MODEL_ROUTE_AVAILABLE");
    error.status=503;
    error.message="MODEL_RUNTIME_UNAVAILABLE: "+error.message;
    throw error;
  }

  const runId=String(accepted.run_id||accepted.id||"");
  if(!runId) throw new Error("HERMES_RUN_ID_MISSING");

  publish("model.selected",{sessionId,missionId,run_id:runId,route:selected.id,provider:selected.provider||"Hermes",model:selected.model||null,role});
  publish("run.started",{sessionId,missionId,run_id:runId,route:selected.id,role});
  if(missionId)addEvent({missionId,type:"run.started",payload:{sessionId,run_id:runId,route:selected.id,role}});

  res.writeHead(200,{"Content-Type":"text/event-stream; charset=utf-8","Cache-Control":"no-cache, no-transform","Connection":"keep-alive","X-Accel-Buffering":"no"});
  res.write(`event: run.started\ndata: ${JSON.stringify({run_id:runId,session_id:sessionId,route:selected.id,role})}\n\n`);

  let outcomeRecorded=false;const selectedSkills=new Set();
  try{
    const upstream=await hermes.runEvents(runId,controller.signal);
    const decoder=new TextDecoder();let buffer="";
    for await(const chunk of upstream.body){
      buffer+=decoder.decode(chunk,{stream:true});
      let split;
      while((split=buffer.indexOf("\n\n"))>=0){
        const block=buffer.slice(0,split);buffer=buffer.slice(split+2);
        const parsed=parseSse(block);if(!parsed)continue;
        const evt=normalizeRunEvent(parsed.type,parsed.data,runId);
        res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt.data)}\n\n`);
        publish(evt.type,{sessionId,missionId,...evt.data});
        if(evt.type==="tool.started"){const skill=skillForTool(evt.data);if(!selectedSkills.has(skill)){selectedSkills.add(skill);publish("skill.selected",{sessionId,missionId,run_id:runId,skill,tool:evt.data?.tool_name||evt.data?.tool||evt.data?.name||null});}}
        if(missionId&&evt.type!=="assistant.delta")addEvent({missionId,type:evt.type,payload:evt.data});

        if(evt.type==="run.completed"){
          recordModelMetric(selected.id,{success:true,latencyMs:Date.now()-started});
          outcomeRecorded=true;
          publish("run.settled",{sessionId,missionId,run_id:runId,route:selected.id,latencyMs:Date.now()-started});
        }else if(evt.type==="run.failed"){
          const message=String(evt.data?.error||"Hermes run failed");
          const classified=classifyModelError({message});
          recordModelMetric(selected.id,{success:false,latencyMs:Date.now()-started,errorClass:classified.errorClass,errorMessage:message,cooldownMs:classified.cooldownMs});
          outcomeRecorded=true;
        }
        if(isTerminalRunEvent(evt.type)) outcomeRecorded=true;
      }
    }

    if(!outcomeRecorded){
      const status=await hermes.runStatus(runId).catch(()=>null);
      if(status?.status==="completed"){
        recordModelMetric(selected.id,{success:true,latencyMs:Date.now()-started});
      }else if(status?.status==="failed"){
        const message=String(status.error||"Hermes run failed");
        const classified=classifyModelError({message});
        recordModelMetric(selected.id,{success:false,latencyMs:Date.now()-started,errorClass:classified.errorClass,errorMessage:message,cooldownMs:classified.cooldownMs});
      }
    }
    res.end();
  }catch(error){
    const classified=classifyModelError(error);
    recordModelMetric(selected.id,{success:false,latencyMs:Date.now()-started,errorClass:classified.errorClass,errorMessage:error.message,cooldownMs:classified.cooldownMs});
    publish("run.failed",{sessionId,missionId,run_id:runId,route:selected.id,error:error.message,latencyMs:Date.now()-started});
    if(!res.writableEnded){
      res.write(`event: error\ndata: ${JSON.stringify({run_id:runId,error:error.message})}\n\n`);
      res.end();
    }
  }
}

const server=http.createServer(async(req,res)=>{
  cors(req,res);if(req.method==="OPTIONS"){res.writeHead(204);return res.end();}
  const url=new URL(req.url,`http://${req.headers.host||"localhost"}`),p=parts(url.pathname);
  try{
    if(req.method==="GET"&&url.pathname==="/api/live"){res.writeHead(200,{"Content-Type":"text/event-stream; charset=utf-8","Cache-Control":"no-cache","Connection":"keep-alive"});return subscribe(res);}
    if(req.method==="POST"&&url.pathname==="/api/telemetry"){const input=await body(req,10000),type=String(input.type||"");if(!UI_TELEMETRY.has(type))return json(res,400,{error:"TELEMETRY_TYPE_NOT_ALLOWED"});if(type==="screen.shared")setRuntimeIntegrationState("browser","CONNECTED","A browser surface is actively shared with ULTRON.");if(type==="screen.stopped"||type==="screen.permission_denied")setRuntimeIntegrationState("browser","AUTH_REQUIRED",type==="screen.stopped"?"Screen sharing stopped.":"Screen permission was not granted.");publish(type,{source:"browser",...(input.data||{})});return json(res,202,{ok:true});}
    if(req.method==="GET"&&url.pathname==="/api/health"){
      const health=await hermes.health();
      return json(res,200,runtimeStatus(health));
    }
    if(req.method==="GET"&&url.pathname==="/api/ready"){
      const health=await hermes.health();
      if(!health.ok)return json(res,503,{...runtimeStatus(health),ok:false,status:"degraded",stage:"hermes-health",health});
      let sessions=unwrapList(await hermes.sessions("limit=2&include_children=true"));
      let session=sessions[0]||null;
      if(!session){
        session=unwrapSession(await hermes.createSession({title:"ULTRON "+new Date().toISOString().replace(/[:.]/g,"-")}));
        sessions=[session];
      }
      const sessionId=String(session?.id||session?.session_id||"");
      if(!sessionId)return json(res,503,{...runtimeStatus(health),ok:false,status:"degraded",stage:"session-create",error:"Hermes returned no session id"});
      await hermes.messages(sessionId);
      return json(res,200,{...runtimeStatus(health),ok:true,status:"online",health,sessionId,modelFabric:fabricStatus()});
    }
    if(req.method==="GET"&&url.pathname==="/api/bootstrap"){
      const health=await hermes.health();
      let sessions=[],sessionError=null;
      if(health.ok){try{sessions=decorateSessions(await hermes.sessions("limit=80&include_children=true"));}catch(error){sessionError=String(error?.message||error);}}
      const missions=visibleMissions(listMissions()),modelFabric=fabricStatus(),runtime=runtimeStatus(health,modelFabric),integrations=await listIntegrations();
      if(sessionError){runtime.status="degraded";runtime.hermes={...runtime.hermes,ok:false,error:sessionError};}
      return json(res,200,{ok:true,runtime,health,sessions,missions,attention:attentionFor(missions,integrations),integrations,leadStats:leadStats(),creatorStats:creatorStats(),modelFabric,overview:systemOverview({missions,health,modelFabric,integrations})});
    }    if(req.method==="GET"&&url.pathname==="/api/system-overview"){const health=await hermes.health().catch(()=>({ok:false})),missions=visibleMissions(listMissions()),modelFabric=fabricStatus(),integrations=await listIntegrations();return json(res,200,systemOverview({missions,health,modelFabric,integrations}));}
    if(req.method==="GET"&&url.pathname==="/api/sessions")return json(res,200,decorateSessions(await hermes.sessions(url.searchParams.toString())));
    if(req.method==="POST"&&url.pathname==="/api/sessions")return json(res,201,unwrapSession(await hermes.createSession(await body(req))));
    if(p[0]==="api"&&p[1]==="sessions"&&p[2]&&req.method==="GET"&&p[3]==="messages")return json(res,200,unwrapList(await hermes.messages(p[2])));
    if(p[0]==="api"&&p[1]==="sessions"&&p[2]&&req.method==="POST"&&p[3]==="branch"){
      const input=await body(req);const result=await createNestedBranch({sourceSessionId:p[2],anchorMessageId:input.anchorMessageId||null,title:input.title||"Follow-up branch"});
      const childId=sessionIdOf(result.session);recordBranch({sessionId:childId,parentSessionId:p[2],anchorMessageId:input.anchorMessageId||null,title:input.title||"Follow-up branch"});
      return json(res,201,{...result,session:{...result.session,branch_metadata:getBranch(childId)}});
    }
    if(p[0]==="api"&&p[1]==="sessions"&&p[2]&&req.method==="PATCH"&&p.length===3){const input=await body(req);const branch=renameBranch(p[2],input.title);return branch?json(res,200,branch):json(res,404,{error:"BRANCH_NOT_FOUND"});}
    if(p[0]==="api"&&p[1]==="sessions"&&p[2]&&req.method==="GET"&&p[3]==="branch-context"){
      const branch=getBranch(p[2]);if(!branch)return json(res,404,{error:"BRANCH_NOT_FOUND"});
      const [parentMessages,childMessages]=await Promise.all([hermes.messages(branch.parentSessionId),hermes.messages(p[2])]);
      const parent=unwrapList(parentMessages),child=unwrapList(childMessages),anchor=branch.anchorMessageId?parent.find(message=>String(message.id||message.message_id||"")===branch.anchorMessageId)||null:null;
      return json(res,200,{branch,parentMessages:parent,childMessages:child,anchorMessage:anchor});
    }
    if(p[0]==="api"&&p[1]==="sessions"&&p[2]&&req.method==="POST"&&p[3]==="chat")return await routeChat(req,res,p[2],await body(req));
    if(req.method==="GET"&&url.pathname==="/api/missions")return json(res,200,visibleMissions(listMissions()));
    if(req.method==="GET"&&url.pathname==="/api/integrations")return json(res,200,{items:await listIntegrations()});
    if(p[0]==="api"&&p[1]==="integrations"&&p[2]&&p[3]==="action"&&req.method==="POST"){const input=await body(req,50000);if(String(input.action||"").toLowerCase()==="propose skill")return json(res,202,{ok:true,approvalRequired:true,status:"APPROVAL_REQUIRED",message:"Review and approve the generated skill proposal before ULTRON modifies its runtime."});return json(res,200,await integrationAction(p[2],input.action,input));}
    if(p[0]==="api"&&p[1]==="missions"&&p[2]&&p[3]==="parameters"&&req.method==="POST"){if(!nativeContacts.isNativeRun(p[2]))return json(res,400,{error:"MISSION_PARAMETER_NOT_SUPPORTED"});return json(res,200,await nativeContacts.provideParameter(p[2],await body(req)));}
    if(req.method==="POST"&&url.pathname==="/api/missions")return json(res,201,createMissionObserved(await body(req)));
    if(req.method==="POST"&&url.pathname==="/api/attachments")return json(res,201,saveAttachment(await body(req,15_000_000)));
    if(req.method==="GET"&&url.pathname==="/api/leads")return json(res,200,{items:listLeads({status:url.searchParams.get("status"),query:url.searchParams.get("q"),limit:url.searchParams.get("limit")||100}),stats:leadStats(url.searchParams.get("target"))});
    if(req.method==="GET"&&url.pathname==="/api/creators")return json(res,200,{items:listCreators({status:url.searchParams.get("status"),niche:url.searchParams.get("niche"),query:url.searchParams.get("q"),limit:url.searchParams.get("limit")||100}),stats:creatorStats(url.searchParams.get("target"))});
    if(p[0]==="api"&&p[1]==="missions"&&p[2]&&req.method==="GET"){const m=getMission(p[2]);return m?json(res,200,{...m,evidence:listEvidence(p[2]),events:listEvents({missionId:p[2],limit:300})}):json(res,404,{error:"MISSION_NOT_FOUND"});}
    if(p[0]==="api"&&p[1]==="missions"&&p[2]&&p[3]==="resume"&&req.method==="POST"){if(nativeContacts.isNativeRun(p[2]))return json(res,202,await nativeContacts.resume(p[2]));return json(res,202,await nativeMissions.resume(p[2]));}
    if(p[0]==="api"&&p[1]==="missions"&&p[2]&&req.method==="PATCH"){const m=updateMissionObserved(p[2],await body(req));return m?json(res,200,m):json(res,404,{error:"MISSION_NOT_FOUND"});}
    if(p[0]==="api"&&p[1]==="runs"&&p[2]&&p[3]==="approval"&&req.method==="POST"){const input=await body(req);if(nativeMissions.isNativeRun(p[2]))return json(res,200,await nativeMissions.approve(p[2],input));if(nativeContacts.isNativeRun(p[2]))return json(res,200,await nativeContacts.approve(p[2],input));const result=await hermes.approval(p[2],input);publish("approval.granted",{run_id:p[2],request_id:input.request_id,choice:input.choice});return json(res,200,result);}
    if(p[0]==="api"&&p[1]==="runs"&&p[2]&&p[3]==="stop"&&req.method==="POST")return json(res,200,await hermes.stopRun(p[2]));
    if(p[0]==="internal"){
      if(!internal(req))return json(res,401,{error:"UNAUTHORIZED"});
      if(req.method==="GET"&&url.pathname==="/internal/status")return json(res,200,{ok:true,missions:listMissions(5),leadStats:leadStats(),creatorStats:creatorStats(),modelFabric:fabricStatus()});
      if(req.method==="GET"&&url.pathname==="/internal/leads")return json(res,200,{items:listLeads({status:url.searchParams.get("status"),query:url.searchParams.get("q"),limit:url.searchParams.get("limit")||100}),stats:leadStats(url.searchParams.get("target"))});
      if(req.method==="POST"&&url.pathname==="/internal/leads")return json(res,201,upsertLead(await body(req)));
      if(req.method==="GET"&&url.pathname==="/internal/creators")return json(res,200,{items:listCreators({status:url.searchParams.get("status"),niche:url.searchParams.get("niche"),query:url.searchParams.get("q"),limit:url.searchParams.get("limit")||100}),stats:creatorStats(url.searchParams.get("target"))});
      if(req.method==="POST"&&url.pathname==="/internal/creators")return json(res,201,upsertCreator(await body(req)));
      if(p[1]==="creators"&&p[2]&&req.method==="GET"){const creator=getCreator(decodeURIComponent(p[2]),url.searchParams.get("platform")||"instagram");return creator?json(res,200,creator):json(res,404,{error:"CREATOR_NOT_FOUND"});}
      if(p[1]==="leads"&&p[2]&&req.method==="GET") {
        const lead=getLead(decodeURIComponent(p[2]));return lead?json(res,200,lead):json(res,404,{error:"LEAD_NOT_FOUND"});
      }
      if(req.method==="POST"&&url.pathname==="/internal/missions")return json(res,201,createMissionObserved(await body(req)));
      if(p[1]==="missions"&&p[2]&&req.method==="GET"&&p.length===3){const m=getMission(p[2]);return m?json(res,200,{...m,evidence:listEvidence(p[2]),events:listEvents({missionId:p[2],limit:300})}):json(res,404,{error:"MISSION_NOT_FOUND"});}
      if(p[1]==="missions"&&p[2]&&req.method==="PATCH"&&p.length===3){const m=updateMissionObserved(p[2],await body(req));return m?json(res,200,m):json(res,404,{error:"MISSION_NOT_FOUND"});}
      if(p[1]==="missions"&&p[2]&&p[3]==="evidence"&&req.method==="POST")return json(res,201,addEvidenceObserved({missionId:p[2],...(await body(req))}));
      if(req.method==="GET"&&url.pathname==="/internal/events")return json(res,200,listEvents({after:url.searchParams.get("after")||0}));
    }
    if(url.pathname.startsWith("/api/")||url.pathname.startsWith("/internal/"))return json(res,404,{error:"NOT_FOUND"});
    if(serveStatic(url.pathname,res))return;
    return json(res,404,{error:"UI_NOT_BUILT",hint:"Run npm run build"});
  }catch(error){return json(res,Number(error.status)||500,{error:error.message,details:error.data||null});}
});
server.listen(config.port,config.host,()=>{console.log(`ULTRON Mark 4 gateway listening on http://${config.host}:${config.port}`);console.log(`Hermes: ${config.hermesUrl}`);});
