import { useEffect, useMemo, useState } from "react";
import { Icon } from "./Icon";

export interface PaletteAction {id:string;title:string;detail:string;group:string;shortcut?:string;}
export function CommandPalette({open,actions,onClose,onChoose}:{open:boolean;actions:PaletteAction[];onClose:()=>void;onChoose:(id:string)=>void}){
  const[query,setQuery]=useState(""),[index,setIndex]=useState(0);
  const rows=useMemo(()=>{const q=query.toLowerCase().trim();return actions.filter(a=>!q||(a.title+" "+a.detail+" "+a.group).toLowerCase().includes(q));},[actions,query]);
  useEffect(()=>{if(open){setQuery("");setIndex(0);}},[open]);
  if(!open)return null;
  return <div className="palette-overlay" onMouseDown={onClose}><section className="command-palette" onMouseDown={e=>e.stopPropagation()}><label><Icon name="palette"/><input autoFocus value={query} onChange={e=>{setQuery(e.target.value);setIndex(0);}} placeholder="Type a command or search…" onKeyDown={e=>{if(e.key==="Escape")onClose();if(e.key==="ArrowDown"){e.preventDefault();setIndex(i=>Math.min(rows.length-1,i+1));}if(e.key==="ArrowUp"){e.preventDefault();setIndex(i=>Math.max(0,i-1));}if(e.key==="Enter"&&rows[index])onChoose(rows[index].id);}}/><kbd>ESC</kbd></label><div className="palette-results">{rows.map((action,i)=><button key={action.id} className={i===index?"selected":""} onMouseEnter={()=>setIndex(i)} onClick={()=>onChoose(action.id)}><span className="palette-symbol">{action.group.slice(0,1)}</span><span><b>{action.title}</b><small>{action.detail}</small></span>{action.shortcut&&<kbd>{action.shortcut}</kbd>}</button>)}{!rows.length&&<div className="empty-list">No command found</div>}</div><footer><span><kbd>↑↓</kbd> Navigate</span><span><kbd>Enter</kbd> Run</span><span>ULTRON command surface</span></footer></section></div>;
}
