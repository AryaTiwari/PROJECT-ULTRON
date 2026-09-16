import { useEffect, useMemo, useState } from "react";
import { api, liveEvents, streamChat } from "./api";
import type { ChatMessage, LiveEvent, Mission, SessionLike, ViewMode } from "./types";
import { CommandView } from "./components/CommandView";
import { MissionPanel } from "./components/MissionPanel";
import { BranchView } from "./components/BranchView";
import { OperationsView } from "./components/OperationsView";

const sessionId=(session:SessionLike)=>String(session.id||session.session_id||"");
const listFrom=(value:any):SessionLike[]=>Array.isArray(value)?value:Array.isArray(value?.data)?value.data:Array.isArray(value?.sessions)?value.sessions:Array.isArray(value?.items)?value.items:[];
const textOf=(content:any):string=>typeof content==="string"?content:Array.isArray(content)?content.map(item=>typeof item==="string"?item:item?.text||item?.content||"").join(""):String(content?.text||content?.content||"");
function normalizeMessages(value:any):ChatMessage[]{
  const rows=Array.isArray(value)?value:Array.isArray(value?.messages)?value.messages:Array.isArray(value?.data)?value.data:Array.isArray(value?.items)?value.items:[];
  return rows.map((m:any,i:number)=>({id:String(m.id||m.message_id||i),role:(m.role||m.type?.split?.("/")[0]||"assistant") as ChatMessage["role"],content:textOf(m.content??m.message?.content??m.text)}))
    .filter((m:ChatMessage)=>Boolean(m.content)&&["user","assistant","system","tool"].includes(m.role));
}
const deltaOf=(data:any)=>String(data?.delta??data?.text??data?.content??data?.output_text?.delta??data?.data?.delta??"");

function Glyph({name}:{name:"chat"|"mission"|"branches"|"ops"|"history"|"plus"}){
  const p={width:19,height:19,viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:1.6,strokeLinecap:"round" as const,strokeLinejoin:"round" as const};
  if(name==="chat")return <svg {...p}><path d="M4 5h16v11H9l-5 4V5Z"/><path d="M8 9h8M8 13h5"/></svg>;
  if(name==="mission")return <svg {...p}><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M22 12h-3M12 22v-3M2 12h3"/></svg>;
  if(name==="branches")return <svg {...p}><circle cx="6" cy="5" r="2"/><circle cx="18" cy="7" r="2"/><circle cx="18" cy="18" r="2"/><path d="M8 5h2c5 0 2 13 8 13M12 10c0-2 2-3 4-3"/></svg>;
  if(name==="ops")return <svg {...p}><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/></svg>;
  if(name==="history")return <svg {...p}><path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.6"/><path d="M4 4v4.6h4.6M12 8v5l3 2"/></svg>;
  return <svg {...p}><path d="M12 5v14M5 12h14"/></svg>;
}

export function App(){
  useEffect(()=>{
    document.documentElement.dataset.ultronMounted="true";
    return()=>{delete document.documentElement.dataset.ultronMounted;};
  },[]);
  const[view,setView]=useState<ViewMode>("command"),[sessions,setSessions]=useState<SessionLike[]>([]),[active,setActive]=useState(""),[messages,setMessages]=useState<ChatMessage[]>([]);
  const[missions,setMissions]=useState<Mission[]>([]),[events,setEvents]=useState<LiveEvent[]>([]),[busy,setBusy]=useState(false),[streaming,setStreaming]=useState(""),[health,setHealth]=useState(false),[error,setError]=useState("");
  const[activeRunId,setActiveRunId]=useState(""),[pendingApproval,setPendingApproval]=useState<any|null>(null),[sessionsOpen,setSessionsOpen]=useState(false),[missionOpen,setMissionOpen]=useState(false),[filter,setFilter]=useState("");
  const mission=missions[0]||null;
  const activeSession=useMemo(()=>sessions.find(s=>sessionId(s)===active),[sessions,active]);
  const filtered=useMemo(()=>{const q=filter.trim().toLowerCase();return sessions.filter(s=>!q||String(s.title||"Untitled").toLowerCase().includes(q));},[sessions,filter]);

  async function refresh(){
    try{
      const data=await api.bootstrap();setHealth(Boolean(data.health?.ok));const rows=listFrom(data.sessions);setSessions(rows);setMissions(data.missions||[]);
      let next=active||sessionId(rows[0]||{});
      if(!next){const created=await api.createSession("ULTRON "+new Date().toLocaleTimeString());const s=created.session||created;next=String(s.id||s.session_id||"");setSessions(listFrom(await api.sessions()));}
      if(next){setActive(next);setMessages(normalizeMessages(await api.messages(next)));}
      setError("");
    }catch(cause:any){setHealth(false);setError(cause.message||"ULTRON runtime unavailable.");}
  }
  useEffect(()=>{
    void refresh();
    const close=liveEvents((type,data)=>setEvents(prev=>[...prev.slice(-119),{type,data,at:data?.at||new Date().toISOString()}]));
    return()=>{
      if(typeof close==="function") close();
    };
  },[]);
  useEffect(()=>{if(active)api.messages(active).then(v=>setMessages(normalizeMessages(v))).catch((e:any)=>setError(e.message));},[active]);
  useEffect(()=>{const e=events.length?events[events.length-1]:undefined;if(e&&["mission.updated","evidence.recorded","run.settled"].includes(e.type))api.bootstrap().then(v=>setMissions(v.missions||[])).catch(()=>{});},[events.length]);

  async function send(text:string){
    if(!active||busy)return;setBusy(true);setStreaming("");setError("");setActiveRunId("");setPendingApproval(null);
    setMessages(prev=>[...prev,{id:"local-"+Date.now(),role:"user",content:text}]);let collected="";
    try{
      let runFailure="";
      await streamChat(active,{input:text,missionId:mission?.id||null,role:"cognition"},(type,data)=>{
        if(type==="run.started")setActiveRunId(String(data?.run_id||data?.runId||""));
        if(type==="approval.request")setPendingApproval(data);
        if(type==="assistant.delta"){const d=deltaOf(data);if(d){collected+=d;setStreaming(collected);}}
        if(type==="run.failed"){
          runFailure=String(data?.error||data?.message||"The active model route failed.");
          setError("MODEL ROUTE FAILED · "+runFailure);
        }
        if(["run.completed","run.failed","run.cancelled","run.interrupted"].includes(type))setPendingApproval(null);
      });
      setStreaming("");setMessages(normalizeMessages(await api.messages(active)));const data=await api.bootstrap();setMissions(data.missions||[]);
      if(runFailure&&!collected)setMessages(prev=>[...prev,{id:"route-failure-"+Date.now(),role:"assistant",content:"Runtime route failed: "+runFailure}]);
    }catch(cause:any){setError(cause.message);if(collected)setMessages(prev=>[...prev,{id:"partial-"+Date.now(),role:"assistant",content:collected}]);setStreaming("");}
    finally{setBusy(false);setActiveRunId("");setPendingApproval(null);}
  }
  async function newSession(){const created=await api.createSession("Session "+new Date().toLocaleString());const s=created.session||created,id=String(s.id||s.session_id||"");setSessions(listFrom(await api.sessions()));if(id){setActive(id);setView("command");setSessionsOpen(false);}}
  async function branch(id:string,title:string,anchorMessageId?:string){const created=await api.branch(id,title,anchorMessageId),s=created.session||created,newId=String(s.id||s.session_id||"");setSessions(listFrom(await api.sessions()));if(newId){setActive(newId);setView("command");}}
  async function resolveApproval(choice:string){if(!activeRunId||!pendingApproval)return;const requestId=String(pendingApproval.request_id||pendingApproval.requestId||"");if(!requestId)throw new Error("Approval request id missing.");await api.approve(activeRunId,requestId,choice);setPendingApproval(null);}
  async function stopRun(){if(activeRunId)await api.stopRun(activeRunId);}

  const labels:Record<ViewMode,string>={command:"Command",mission:"Mission",branches:"Branches",operations:"Operations"};
  return <div className="u4-shell">
    <aside className="u4-rail">
      <button className="u4-logo" onClick={()=>setView("command")}><span>U</span><b>04</b></button>
      <nav>
        <button className={view==="command"?"active":""} onClick={()=>setView("command")} title="Command"><Glyph name="chat"/></button>
        <button className={view==="branches"?"active":""} onClick={()=>setView("branches")} title="Branches"><Glyph name="branches"/></button>
        <button className={view==="operations"?"active":""} onClick={()=>setView("operations")} title="Operations"><Glyph name="ops"/></button>
      </nav>
      <div className="u4-rail-bottom">
        <button onClick={()=>setSessionsOpen(true)} title="Sessions"><Glyph name="history"/></button>
        <button onClick={()=>void newSession()} title="New session"><Glyph name="plus"/></button>
        <i className={health?"online":"offline"}/>
      </div>
    </aside>

    <section className="u4-stage">
      <header className="u4-topbar">
        <button className="u4-session-trigger" onClick={()=>setSessionsOpen(true)}><span>SESSION</span><strong>{activeSession?.title||"Untitled"}</strong></button>
        <div className="u4-top-center"><span className={health?"u4-status online":"u4-status offline"}><i/>{health?"ONLINE":"OFFLINE"}</span>{busy&&<span className="u4-working"><i/>EXECUTING</span>}</div>
        <div className="u4-top-actions">
          {mission&&<button className="u4-mission-pill" onClick={()=>setMissionOpen(true)}><span>MISSION</span><strong>{mission.status}</strong></button>}
          <span className="u4-build">MARK 4 / COGNITIVE OS</span>
        </div>
      </header>

      <main className="u4-workspace">
        <div className="u4-watermark">04</div>
        {view==="command"&&<CommandView messages={messages} events={events} streaming={streaming} busy={busy} mission={mission} onSend={send}
          onBranch={messageId=>branch(active,"Follow-up branch",messageId)} runId={activeRunId} approval={pendingApproval} onApproval={resolveApproval} onStop={stopRun}/>}
        {view==="mission"&&<div className="mission-full"><MissionPanel mission={mission}/></div>}
        {view==="branches"&&<BranchView sessions={sessions} activeId={active} onSelect={id=>{setActive(id);setView("command");}} onFork={(id,title)=>branch(id,title)}/>}
        {view==="operations"&&<OperationsView events={events} mission={mission}/>}
      </main>
      {error&&<div className="u4-error"><div><b>RUNTIME</b><span>{error}</span></div><button onClick={()=>void refresh()}>RETRY</button></div>}
    </section>

    {sessionsOpen&&<div className="u4-overlay" onMouseDown={()=>setSessionsOpen(false)}>
      <aside className="u4-drawer left" onMouseDown={e=>e.stopPropagation()}>
        <div className="u4-drawer-head"><div><span>ULTRON</span><h2>Sessions</h2></div><button onClick={()=>setSessionsOpen(false)}>×</button></div>
        <div className="u4-search"><span>⌕</span><input autoFocus value={filter} onChange={e=>setFilter(e.target.value)} placeholder="Search conversations"/></div>
        <button className="u4-new-session" onClick={()=>void newSession()}><Glyph name="plus"/>New session</button>
        <div className="u4-session-list">{filtered.map(s=><button key={sessionId(s)} className={active===sessionId(s)?"active":""} onClick={()=>{setActive(sessionId(s));setView("command");setSessionsOpen(false);}}>
          <span>{s.title||"Untitled session"}</span><small>{sessionId(s).slice(0,10)}</small>
        </button>)}</div>
      </aside>
    </div>}

    {missionOpen&&<div className="u4-overlay" onMouseDown={()=>setMissionOpen(false)}>
      <aside className="u4-drawer right" onMouseDown={e=>e.stopPropagation()}>
        <div className="u4-drawer-head"><div><span>OBJECTIVE</span><h2>Mission control</h2></div><button onClick={()=>setMissionOpen(false)}>×</button></div>
        <MissionPanel mission={mission}/>
      </aside>
    </div>}
  </div>;
}
