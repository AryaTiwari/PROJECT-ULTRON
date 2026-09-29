import {useEffect,useRef,type ReactNode} from "react";
import {createPortal} from "react-dom";

// A single focus boundary shared by product dialogs. Escape dismisses without granting permission.
export function Dialog(p:{title:string;children:ReactNode;onClose?:()=>void;className?:string}){
 const ref=useRef<HTMLElement>(null),close=useRef(p.onClose);close.current=p.onClose;
 useEffect(()=>{const previous=document.activeElement as HTMLElement|null,root=ref.current!;
 const focusable=()=>Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],summary,[tabindex="0"]')).filter(x=>x.getClientRects().length>0);
 const timer=requestAnimationFrame(()=>{(root.querySelector<HTMLElement>("[autofocus]")||focusable()[0]||root).focus()});
 const key=(e:KeyboardEvent)=>{if(e.key==="Escape"){e.preventDefault();e.stopPropagation();close.current?.()}if(e.key==="Tab"){const list=focusable(),first=list[0]||root,last=list.at(-1)||root;if(!list.length){e.preventDefault();root.focus()}else if(e.shiftKey&&(document.activeElement===first||!root.contains(document.activeElement))){e.preventDefault();last.focus()}else if(!e.shiftKey&&(document.activeElement===last||!root.contains(document.activeElement))){e.preventDefault();first.focus()}}};
 const focus=(e:FocusEvent)=>{if(!root.contains(e.target as Node))(focusable()[0]||root).focus()};
 document.addEventListener("keydown",key,true);document.addEventListener("focusin",focus);
 return()=>{cancelAnimationFrame(timer);document.removeEventListener("keydown",key,true);document.removeEventListener("focusin",focus);previous?.isConnected&&previous.focus()};
 },[]);
 return createPortal(<div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)p.onClose?.()}}><section ref={ref} tabIndex={-1} className={"product-dialog glass-panel "+(p.className||"")} role="dialog" aria-modal="true" aria-label={p.title}>{p.children}</section></div>,document.body);
}
