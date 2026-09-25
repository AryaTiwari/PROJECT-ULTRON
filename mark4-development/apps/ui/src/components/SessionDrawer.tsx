import type { Mission, SessionLike } from "../types";
import { Icon } from "./Icon";

const idOf=(s:SessionLike)=>String(s.id||s.session_id||"");
const parentOf=(s:SessionLike)=>String(s.parent_session_id||s.parent_id||s.branch_metadata?.parentSessionId||"");
const stamp=(value:unknown)=>{const date=new Date(String(value||""));if(Number.isNaN(date.valueOf()))return "Recent";const delta=Date.now()-date.valueOf();if(delta<60_000)return "Now";if(delta<3_600_000)return Math.max(1,Math.round(delta/60_000))+"m";if(delta<86_400_000)return Math.round(delta/3_600_000)+"h";return date.toLocaleDateString(undefined,{month:"short",day:"numeric"});};

export function SessionDrawer({open,sessions,missions,activeId,busy,query,onQuery,onClose,onNew,onSelect}:{open:boolean;sessions:SessionLike[];missions:Mission[];activeId:string;busy:boolean;query:string;onQuery:(value:string)=>void;onClose:()=>void;onNew:()=>void;onSelect:(id:string)=>void}){
  if(!open)return null;
  const q=query.trim().toLowerCase();
  const filtered=sessions.filter(s=>!q||String(s.title||"Untitled").toLowerCase().includes(q)||idOf(s).toLowerCase().includes(q));
  const branches=filtered.filter(s=>parentOf(s));
  const roots=filtered.filter(s=>!parentOf(s));
  const missionIds=new Set(missions.flatMap(m=>m.relatedSessions||[]));
  const missionSessions=roots.filter(s=>missionIds.has(idOf(s)));
  const recent=roots.filter(s=>!missionIds.has(idOf(s)));
  const group=(label:string,rows:SessionLike[])=>rows.length?<section className="drawer-group"><h3>{label}<span>{rows.length}</span></h3>{rows.map(s=>{const id=idOf(s);return <button key={id} className={id===activeId?"session-row active":"session-row"} onClick={()=>onSelect(id)}><span className="session-glyph">{parentOf(s)?"↳":"◇"}</span><span className="session-copy"><b>{s.title||"Untitled session"}</b><small>{id===activeId&&busy?"Working":parentOf(s)?"Branch":"Ready"}</small></span><time>{stamp(s.updated_at||s.created_at||s.branch_metadata?.updatedAt)}</time></button>})}</section>:null;
  return <div className="overlay" onMouseDown={onClose}><aside className="session-drawer" onMouseDown={e=>e.stopPropagation()}><header className="drawer-header"><div><span className="kicker">CONVERSATIONS</span><h2>Sessions</h2></div><button className="icon-button" onClick={onClose}><Icon name="close"/></button></header><label className="search-field"><Icon name="search"/><input autoFocus value={query} onChange={e=>onQuery(e.target.value)} placeholder="Search title or session ID"/><kbd>ESC</kbd></label><button className="new-session" onClick={onNew}><Icon name="plus"/><span>New conversation</span><kbd>Ctrl N</kbd></button><div className="drawer-scroll">{group("Mission linked",missionSessions)}{group("Recent",recent)}{group("Branches",branches)}{!filtered.length&&<div className="empty-list">No matching sessions</div>}</div></aside></div>;
}
