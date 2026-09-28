import type{ReactNode}from"react";
export function Tooltip({label,children,side="right"}:{label:string;children:ReactNode;side?:"right"|"top"|"bottom"}){
 return <span className={"tooltip-wrap tooltip-"+side} tabIndex={-1}>{children}<span className="tooltip-bubble" role="tooltip">{label}</span></span>;
}
