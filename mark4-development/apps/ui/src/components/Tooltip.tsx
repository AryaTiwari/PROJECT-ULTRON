import {useId,useRef,useState,type ReactNode} from "react";
import {createPortal} from "react-dom";
export function Tooltip({label,children}:{label:string;children:ReactNode;side?:"right"|"top"|"bottom"}){
 const ref=useRef<HTMLSpanElement>(null),id=useId(),[position,setPosition]=useState<{left:number;top:number}|null>(null);
 function show(){const r=ref.current?.getBoundingClientRect();if(r)setPosition({left:Math.max(8,Math.min(window.innerWidth-160,r.right+8)),top:r.bottom>window.innerHeight-90?Math.max(8,r.top-40):r.top+Math.max(0,(r.height-32)/2)})}
 return <span ref={ref} className="tooltip-wrap" onMouseEnter={show} onMouseLeave={()=>setPosition(null)} onFocus={show} onBlur={()=>setPosition(null)} onKeyDown={e=>{if(e.key==="Escape")setPosition(null)}} aria-describedby={position?id:undefined}>{children}{position&&createPortal(<span id={id} role="tooltip" className="product-tooltip" style={position}>{label}</span>,document.body)}</span>;
}
