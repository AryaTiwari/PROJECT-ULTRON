import type { Mission } from "../types";

function numeric(value:unknown){const number=Number(value);return Number.isFinite(number)?number:null;}
function pretty(value:Record<string,unknown>){
  const entries=Object.entries(value||{}).slice(0,4);
  return entries.length?entries.map(([k,v])=>`${k.replaceAll("_"," ")}: ${typeof v==="object"?JSON.stringify(v):String(v)}`).join(" · "):"Dynamic";
}

export function MissionPanel({mission}:{mission?:Mission|null}){
  if(!mission)return <aside className="mission-panel empty-mission">
    <div className="mission-panel-head"><span className="micro-label">MISSION</span><span className="status-chip muted">IDLE</span></div>
    <h3>No persistent objective</h3>
    <p className="mission-muted">Long-running work, numerical targets and multi-tool objectives will appear here automatically.</p>
  </aside>;

  const state:any=mission.state||{},completion:any=mission.completionCriteria||{};
  const current=numeric(state.current??state.masterCurrent??state.completed);
  const target=numeric(state.target??state.targetTotal??completion.target);
  const percent=current!==null&&target&&target>0?Math.max(0,Math.min(100,Math.round(current/target*100))):null;
  const evidence=mission.evidence?.length??0;

  return <aside className="mission-panel">
    <div className="mission-panel-head"><span className="micro-label">ACTIVE MISSION</span><span className={"status-chip "+mission.status}><i/>{mission.status}</span></div>
    <h3>{mission.objective}</h3>
    {percent!==null&&<div className="mission-progress-block"><div className="metric-row"><strong>{current}<small> / {target}</small></strong><span>{percent}%</span></div><div className="progress"><span style={{width:percent+"%"}}/></div></div>}
    <div className="mission-section"><span>Next action</span><p>{mission.nextAction||"ULTRON is selecting the next useful action."}</p></div>
    <div className="mission-section"><span>Strategy</span><p>{pretty(mission.strategy||{})}</p></div>
    <div className="mission-stats"><div><strong>{evidence}</strong><span>Evidence</span></div><div><strong>{Object.keys(mission.constraints||{}).length}</strong><span>Constraints</span></div></div>
    <div className="mission-id">#{mission.id.slice(-10)}</div>
  </aside>;
}
