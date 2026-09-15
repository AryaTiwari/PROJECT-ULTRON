import React,{useMemo,useRef,useState} from "react";
import type {ChatMessage,LiveEvent,Mission} from "../types";

function toolName(event:LiveEvent){
  const data:any=event.data||{};
  return String(data.name||data.tool_name||data.tool||data.function||event.type).replace(/^ultron_/,"").replaceAll("_"," ");
}

function MicIcon(){
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/></svg>;
}
function ArrowIcon(){
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m6 12 6-6 6 6M12 6v12"/></svg>;
}

export function CommandView(props:{
  messages:ChatMessage[];events:LiveEvent[];streaming:string;busy:boolean;mission?:Mission|null;
  onSend:(text:string)=>Promise<void>;onBranch:(messageId:string)=>Promise<void>;runId?:string;
  approval?:any|null;onApproval:(choice:string)=>Promise<void>;onStop:()=>Promise<void>;
}){
  const[draft,setDraft]=useState(""),[listening,setListening]=useState(false);
  const endRef=useRef<HTMLDivElement|null>(null);
  React.useEffect(()=>endRef.current?.scrollIntoView({behavior:"smooth"}),[props.messages,props.streaming,props.approval]);

  const tools=useMemo(()=>props.events.filter(e=>/tool\.|subagent\./.test(e.type)).slice(-4),[props.events]);

  async function submit(){
    const value=draft.trim();if(!value||props.busy)return;setDraft("");await props.onSend(value);
  }
  function voice(){
    const w:any=window;const Recognition=w.SpeechRecognition||w.webkitSpeechRecognition;
    if(!Recognition){setDraft(v=>v||"Voice recognition is unavailable in this browser.");return;}
    const recognition=new Recognition();recognition.lang="en-IN";recognition.interimResults=false;recognition.continuous=false;
    recognition.onstart=()=>setListening(true);recognition.onend=()=>setListening(false);
    recognition.onresult=(event:any)=>setDraft(String(event.results?.[0]?.[0]?.transcript||""));
    recognition.start();
  }

  return <section className="command-view">
    <div className="conversation">
      {props.messages.length===0&&<div className="empty-state">
        <div className="core-orb"><span/><i/><b/></div>
        <div className="empty-copy">
          <span className="micro-label">ULTRON COGNITION ONLINE</span>
          <h3>What are we building?</h3>
          <p>Give me an objective. I’ll decide the path, use the right capabilities, preserve evidence and keep persistent work as a mission.</p>
        </div>
        <div className="starter-grid">
          <button onClick={()=>setDraft("Inspect the Mark 4 runtime and tell me what needs attention first.")}>Inspect the system<span>Runtime health →</span></button>
          <button onClick={()=>setDraft("Create a persistent mission for my highest-priority Elevate OS objective.")}>Start a mission<span>Persistent objective →</span></button>
          <button onClick={()=>setDraft("Research the best next acquisition opportunity for Elevate OS using current evidence.")}>Research growth<span>Evidence-first →</span></button>
        </div>
      </div>}

      {props.messages.map(message=><article key={message.id} className={"message "+message.role}>
        <div className="message-avatar">{message.role==="assistant"?"U":message.role==="user"?"A":"·"}</div>
        <div className="message-column">
          <div className="message-head">
            <span>{message.role==="user"?"You":message.role==="assistant"?"ULTRON":message.role}</span>
            {message.role==="assistant"&&!String(message.id).startsWith("local-")&&
              <button className="branch-action" disabled={props.busy} onClick={()=>void props.onBranch(message.id)}>Branch ↗</button>}
          </div>
          <div className="message-body">{message.content}</div>
        </div>
      </article>)}

      {props.streaming&&<article className="message assistant streaming">
        <div className="message-avatar live">U</div>
        <div className="message-column"><div className="message-head"><span>ULTRON</span><em>responding</em></div><div className="message-body">{props.streaming}<span className="cursor"/></div></div>
      </article>}

      {props.approval&&<div className="approval-card">
        <div className="approval-icon">!</div>
        <div className="approval-content">
          <div className="approval-top"><strong>Approval required</strong><span>{String(props.approval.tool_name||props.approval.tool||props.approval.kind||"external action")}</span></div>
          <p>{String(props.approval.description||props.approval.reason||"ULTRON needs permission before continuing this action.")}</p>
          {props.approval.command&&<code>{String(props.approval.command)}</code>}
          <div className="approval-actions">{(Array.isArray(props.approval.choices)?props.approval.choices:["once","deny"]).map((choice:string)=>
            <button key={choice} className={choice==="deny"?"deny":""} onClick={()=>void props.onApproval(choice)}>
              {choice==="once"?"Allow once":choice==="session"?"Allow this session":choice==="always"?"Always allow":"Deny"}
            </button>)}</div>
        </div>
      </div>}

      {props.busy&&tools.length>0&&<div className="activity-card">
        <div className="activity-line"><span className="activity-pulse"/><strong>Working</strong><span>{tools.length} active event{tools.length===1?"":"s"}</span></div>
        <div className="activity-tools">{tools.map((event,index)=><span key={index}>{toolName(event)}</span>)}</div>
      </div>}
      <div ref={endRef}/>
    </div>

    <div className="composer-shell">
      <div className={"composer "+(draft?"has-value":"")}>
        <textarea value={draft} onChange={e=>setDraft(e.target.value)} placeholder="Message ULTRON…" rows={1}
          onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();void submit();}}}/>
        <div className="composer-bottom">
          <div className="composer-meta">{props.mission?<><span className="mission-dot"/>Mission active</>:"Shift + Enter for new line"}</div>
          <div className="composer-actions">
            <button className={"voice-button "+(listening?"active":"")} onClick={voice} title="Voice input"><MicIcon/></button>
            {props.busy
              ?<button className="send-button stop" disabled={!props.runId} onClick={()=>void props.onStop()} title="Stop run">■</button>
              :<button className="send-button" disabled={!draft.trim()} onClick={()=>void submit()} title="Send"><ArrowIcon/></button>}
          </div>
        </div>
      </div>
    </div>
  </section>;
}
