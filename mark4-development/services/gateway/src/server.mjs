import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { config, uiDist } from "./config.mjs";
import { hermes } from "./hermes.mjs";
import { createMission,getMission,listMissions,updateMission,addEvidence,listEvidence,addEvent,listEvents,recordModelMetric,upsertLead,getLead,listLeads,leadStats,upsertCreator,getCreator,listCreators,creatorStats } from "./db.mjs";
import { rankModels,fabricStatus,classifyModelError } from "./model-fabric.mjs";
import { subscribe,publish } from "./event-hub.mjs";
import { unwrapList, unwrapSession } from "./hermes-contract.mjs";
import { createNestedBranch } from "./branching.mjs";
import { normalizeRunEvent, isTerminalRunEvent } from "./run-events.mjs";

const json=(res,status,value)=>{res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});res.end(JSON.stringify(value));};
const body=req=>new Promise((resolve,reject)=>{let raw="";req.setEncoding("utf8");req.on("data",c=>{raw+=c;if(raw.length>2_000_000)reject(new Error("REQUEST_TOO_LARGE"));});req.on("end",()=>{try{resolve(raw?JSON.parse(raw):{});}catch(e){reject(e);}});req.on("error",reject);});
const parts=pathname=>pathname.split("/").filter(Boolean);
const internal=req=>Boolean(config.internalKey)&&req.headers["x-ultron-internal-key"]===config.internalKey;

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
async function proxyChat(req,res,sessionId,input){
  const role=String(input.role||"cognition"),missionId=input.missionId||null;
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
      publish("model.route_failed",{sessionId,missionId,route:candidate.id,errorClass:classified.errorClass,error:error.message});
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

  publish("run.started",{sessionId,missionId,run_id:runId,route:selected.id,role});
  if(missionId)addEvent({missionId,type:"run.started",payload:{sessionId,run_id:runId,route:selected.id,role}});

  res.writeHead(200,{"Content-Type":"text/event-stream; charset=utf-8","Cache-Control":"no-cache, no-transform","Connection":"keep-alive","X-Accel-Buffering":"no"});
  res.write(`event: run.started\ndata: ${JSON.stringify({run_id:runId,session_id:sessionId,route:selected.id,role})}\n\n`);

  let outcomeRecorded=false;
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
    if(req.method==="GET"&&url.pathname==="/api/ready"){
      const health=await hermes.health();
      if(!health.ok)return json(res,503,{ok:false,stage:"hermes-health",health});
      let sessions=unwrapList(await hermes.sessions("limit=2&include_children=true"));
      let session=sessions[0]||null;
      if(!session){
        session=unwrapSession(await hermes.createSession({title:"ULTRON "+new Date().toISOString().replace(/[:.]/g,"-")}));
        sessions=[session];
      }
      const sessionId=String(session?.id||session?.session_id||"");
      if(!sessionId)return json(res,503,{ok:false,stage:"session-create",error:"Hermes returned no session id"});
      await hermes.messages(sessionId);
      return json(res,200,{ok:true,health,sessionId,modelFabric:fabricStatus()});
    }
    if(req.method==="GET"&&url.pathname==="/api/bootstrap"){const[health,sessions]=await Promise.all([hermes.health(),hermes.sessions("limit=40&include_children=true")]);return json(res,200,{health,sessions:unwrapList(sessions),missions:listMissions(),leadStats:leadStats(),creatorStats:creatorStats(),modelFabric:fabricStatus()});}
    if(req.method==="GET"&&url.pathname==="/api/sessions")return json(res,200,unwrapList(await hermes.sessions(url.searchParams.toString())));
    if(req.method==="POST"&&url.pathname==="/api/sessions")return json(res,201,unwrapSession(await hermes.createSession(await body(req))));
    if(p[0]==="api"&&p[1]==="sessions"&&p[2]&&req.method==="GET"&&p[3]==="messages")return json(res,200,unwrapList(await hermes.messages(p[2])));
    if(p[0]==="api"&&p[1]==="sessions"&&p[2]&&req.method==="POST"&&p[3]==="branch"){
      const input=await body(req);return json(res,201,await createNestedBranch({sourceSessionId:p[2],anchorMessageId:input.anchorMessageId||null,title:input.title||"Follow-up branch"}));
    }
    if(p[0]==="api"&&p[1]==="sessions"&&p[2]&&req.method==="POST"&&p[3]==="chat")return await proxyChat(req,res,p[2],await body(req));
    if(req.method==="GET"&&url.pathname==="/api/missions")return json(res,200,listMissions());
    if(req.method==="GET"&&url.pathname==="/api/leads")return json(res,200,{items:listLeads({status:url.searchParams.get("status"),query:url.searchParams.get("q"),limit:url.searchParams.get("limit")||100}),stats:leadStats(url.searchParams.get("target"))});
    if(req.method==="GET"&&url.pathname==="/api/creators")return json(res,200,{items:listCreators({status:url.searchParams.get("status"),niche:url.searchParams.get("niche"),query:url.searchParams.get("q"),limit:url.searchParams.get("limit")||100}),stats:creatorStats(url.searchParams.get("target"))});
    if(p[0]==="api"&&p[1]==="missions"&&p[2]&&req.method==="GET"){const m=getMission(p[2]);return m?json(res,200,{...m,evidence:listEvidence(p[2])}):json(res,404,{error:"MISSION_NOT_FOUND"});}
    if(p[0]==="api"&&p[1]==="runs"&&p[2]&&p[3]==="approval"&&req.method==="POST")return json(res,200,await hermes.approval(p[2],await body(req)));
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
      if(req.method==="POST"&&url.pathname==="/internal/missions")return json(res,201,createMission(await body(req)));
      if(p[1]==="missions"&&p[2]&&req.method==="GET"&&p.length===3){const m=getMission(p[2]);return m?json(res,200,{...m,evidence:listEvidence(p[2])}):json(res,404,{error:"MISSION_NOT_FOUND"});}
      if(p[1]==="missions"&&p[2]&&req.method==="PATCH"&&p.length===3){const m=updateMission(p[2],await body(req));return m?json(res,200,m):json(res,404,{error:"MISSION_NOT_FOUND"});}
      if(p[1]==="missions"&&p[2]&&p[3]==="evidence"&&req.method==="POST")return json(res,201,addEvidence({missionId:p[2],...(await body(req))}));
      if(req.method==="GET"&&url.pathname==="/internal/events")return json(res,200,listEvents({after:url.searchParams.get("after")||0}));
    }
    if(url.pathname.startsWith("/api/")||url.pathname.startsWith("/internal/"))return json(res,404,{error:"NOT_FOUND"});
    if(serveStatic(url.pathname,res))return;
    return json(res,404,{error:"UI_NOT_BUILT",hint:"Run npm run build"});
  }catch(error){return json(res,Number(error.status)||500,{error:error.message,details:error.data||null});}
});
server.listen(config.port,config.host,()=>{console.log(`ULTRON Mark 4 gateway listening on http://${config.host}:${config.port}`);console.log(`Hermes: ${config.hermesUrl}`);});
