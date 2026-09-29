import {useState} from "react";
import {Dialog} from "./Dialog";
import {Icon} from "./Icon";
export function ApprovalModal(p:{approval:any;busy?:boolean;onResolve:(choice:string)=>Promise<void>;onClose?:()=>void}){
 const[saving,setSaving]=useState(false),[error,setError]=useState("");
 if(!p.approval)return null;
 const a=p.approval,choices:string[]=a.choices?.length?a.choices:["once","deny"],kind=String(a.kind||a.tool_name||a.tool||"External action"),label=(c:string)=>c==="once"?"Allow once":c==="mission"?"Allow mission":c==="deny"?"Decline":c==="connect"?"Connect":c.replaceAll("_"," ");
 async function resolve(choice:string){if(saving||p.busy)return;setSaving(true);setError("");try{await p.onResolve(choice)}catch(e:any){setError(e.message||"Could not save your decision. Please retry.")}finally{setSaving(false)}}
 return <Dialog title="Permission required" onClose={p.onClose} className="approval-modal"><div className="approval-orbit"><Icon name="warning"/></div><div className="approval-copy"><span className="eyebrow">PERMISSION REQUIRED</span><h2>{/apollo/i.test(kind)?"Use Apollo?":kind+"?"}</h2><p>{String(a.description||a.message||a.reason||"Review this action before ULTRON continues.")}</p><dl><div><dt>Scope</dt><dd>{a.scope|| (choices.includes("mission")?"This action or this mission":"This action only")}</dd></div>{(a.estimatedCalls!=null||a.estimatedCost!=null)&&<div><dt>Estimate</dt><dd>{a.estimatedCalls!=null?a.estimatedCalls+" calls":a.estimatedCost}</dd></div>}</dl><div className="modal-actions">{[...choices].sort((x,y)=>Number(y==="deny")-Number(x==="deny")).map(c=><button key={c} disabled={saving||p.busy} className={c==="deny"?"secondary":c==="once"||c==="connect"?"primary":""} onClick={()=>void resolve(c)}>{saving?"Saving…":label(c)}</button>)}</div>{error&&<p role="alert">{error}</p>}<small>Your decision applies only to the scope above.</small>{p.onClose&&<button className="text-action" onClick={p.onClose}>Decide later</button>}</div></Dialog>
}
