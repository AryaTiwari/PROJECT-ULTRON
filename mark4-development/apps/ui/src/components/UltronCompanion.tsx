import {useEffect,useMemo,useRef,useState} from "react";
import type{LiveEvent,Mission,ViewMode}from"../types";

type Mood="ready"|"thinking"|"working"|"pleased"|"concerned"|"listening"|"offline";
const moodFrom=(events:LiveEvent[],online:boolean,degraded:boolean,busy:boolean,approval:boolean,voice:string):Mood=>{if(!online)return"offline";if(degraded)return"concerned";if(voice==="listening"||voice==="transcribing")return"listening";if(approval)return"concerned";const type=events.at(-1)?.type||"";if(type==="mission.completed"||type==="artifact.created")return"pleased";if(/failed|error|blocked/.test(type))return"concerned";if(busy||/tool\.|sheet\.|apollo\.|run\.started/.test(type))return"working";if(/request|model\.selected|skill\.selected/.test(type))return"thinking";return"ready";};
const labels:Record<Mood,string>={ready:"Ready",thinking:"Thinking",working:"Executing",pleased:"Mission complete",concerned:"Needs attention",listening:"Listening",offline:"Core offline"};
export function UltronCompanion(p:{events:LiveEvent[];online:boolean;degraded:boolean;busy:boolean;approval:boolean;error:boolean;hasArtifact:boolean;voiceState:string;mission?:Mission|null;onNavigate:(v:ViewMode)=>void;onVoice:()=>void;onFile:(file:File)=>void;}){
 const mood=useMemo(()=>moodFrom(p.events,p.online,p.degraded,p.busy,p.approval,p.voiceState),[p.events.length,p.online,p.degraded,p.busy,p.approval,p.voiceState]);
 const [pos,setPos]=useState<{x:number;y:number}>(()=>{try{const saved=JSON.parse(localStorage.getItem("ultron.companion.position")||"null");return saved&&typeof saved.x==="number"?saved:{x:0,y:0}}catch{return{x:0,y:0}}});
 const [menu,setMenu]=useState(false),[dragging,setDragging]=useState(false);
 const origin=useRef({x:0,y:0,px:0,py:0,moved:false}),hold=useRef<number|undefined>(undefined);
 useEffect(()=>{localStorage.setItem("ultron.companion.position",JSON.stringify(pos))},[pos]);
 const route=()=>p.error?p.onNavigate("system"):p.approval?p.onNavigate("mission"):p.mission?p.onNavigate("mission"):p.hasArtifact?p.onNavigate("outputs"):p.onNavigate("command");
 function down(e:React.PointerEvent){origin.current={x:e.clientX,y:e.clientY,px:pos.x,py:pos.y,moved:false};setDragging(true);(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);hold.current=window.setTimeout(()=>{p.onVoice();hold.current=undefined},650)}
 function move(e:React.PointerEvent){if(!dragging)return;const dx=e.clientX-origin.current.x,dy=e.clientY-origin.current.y;if(Math.abs(dx)+Math.abs(dy)>7){origin.current.moved=true;if(hold.current)clearTimeout(hold.current)}setPos({x:Math.max(-window.innerWidth+190,Math.min(40,origin.current.px+dx)),y:Math.max(-window.innerHeight+220,Math.min(40,origin.current.py+dy))})}
 function up(){if(hold.current)clearTimeout(hold.current);setDragging(false);if(!origin.current.moved)route()}
 return <div className={"ultron-companion "+mood+(dragging?" dragging":"")} style={{transform:`translate3d(${pos.x}px,${pos.y}px,0)`}} onPointerDown={down} onPointerMove={move} onPointerUp={up} onDoubleClick={e=>{e.stopPropagation();p.onNavigate("command")}} onContextMenu={e=>{e.preventDefault();setMenu(v=>!v)}} onDragOver={e=>{e.preventDefault();e.dataTransfer.dropEffect="copy"}} onDrop={e=>{e.preventDefault();const f=e.dataTransfer.files?.[0];if(f)p.onFile(f)}} role="button" tabIndex={0} aria-label={`ULTRON companion: ${labels[mood]}`} title={`${labels[mood]} · drag to move · hold for voice · drop a file`}>
  <div className="companion-status"><i/><span>{labels[mood]}</span></div>
  <svg className="ultron-body" viewBox="0 0 180 220" aria-hidden="true">
   <defs><linearGradient id="armor" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#fff"/><stop offset=".4" stopColor="#aeb8c9"/><stop offset="1" stopColor="#3e4658"/></linearGradient><linearGradient id="dark" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#353e51"/><stop offset="1" stopColor="#090b14"/></linearGradient><radialGradient id="reactor"><stop stopColor="#fff3c0"/><stop offset=".28" stopColor="#ff9a2f"/><stop offset="1" stopColor="#f23b10"/></radialGradient></defs>
   <ellipse cx="90" cy="208" rx="55" ry="8" fill="#000" opacity=".35"/>
   <g className="pet-arms"><path d="M50 86 25 102 14 146l17 6 19-34 15-13z" fill="url(#armor)" stroke="#d8e4f7"/><path d="m130 86 25 16 11 44-17 6-19-34-15-13z" fill="url(#armor)" stroke="#d8e4f7"/><path d="m21 144-7 25 13 5 10-24zM159 144l7 25-13 5-10-24z" fill="url(#dark)" stroke="#8d99ad"/></g>
   <path d="M55 78 90 66l35 12 18 54-18 28H55l-18-28z" fill="url(#dark)" stroke="#8996aa" strokeWidth="2"/><path d="m51 87 20-12 8 44-23 24-13-17zM129 87l-20-12-8 44 23 24 13-17z" fill="url(#armor)"/><path d="M75 78h30l12 48-27 25-27-25z" fill="#252d3c" stroke="#d5dfec"/><circle className="arc-core" cx="90" cy="113" r="15" fill="url(#reactor)"/><circle cx="90" cy="113" r="23" fill="none" stroke="#ff6b22" opacity=".55"/>
   <g className="pet-head"><path d="M60 36 78 14h24l18 22-5 36-25 14-25-14z" fill="url(#armor)" stroke="#e4ecf7" strokeWidth="2"/><path d="m67 43 14-10 9 8 9-8 14 10-7 21-16 10-16-10z" fill="#222a39"/><path className="pet-eyes" d="m72 48 14 5-12 5zm36 0-14 5 12 5z" fill="#ff6a24"/><path d="M85 61h10l6 6-11 8-11-8z" fill="#717d91"/></g>
   <g className="pet-legs"><path d="m61 151 24 3-5 42-24 4-8-17zM119 151l-24 3 5 42 24 4 8-17z" fill="url(#armor)" stroke="#c6d1e1"/><path d="m55 190 26-3 5 17-37 2zM125 190l-26-3-5 17 37 2z" fill="url(#dark)" stroke="#8996aa"/></g>
  </svg>
  {menu&&<div className="companion-menu" onPointerDown={e=>e.stopPropagation()}>{[["command","Open chat"],["mission","Active mission"],["outputs","Outputs"],["system","System health"]].map(([id,label])=><button key={id} onClick={()=>{setMenu(false);p.onNavigate(id as ViewMode)}}>{label}</button>)}</div>}
 </div>
}
