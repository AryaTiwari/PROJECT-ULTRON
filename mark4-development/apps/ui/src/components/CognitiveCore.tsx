import { useEffect, useRef } from "react";
import type { CoreState } from "../activity";
const tones:Record<CoreState,string>={idle:"#4f9cff",listening:"#44d6ee",transcribing:"#7cc9ff",understanding:"#559fff",model:"#78b7ff",skill:"#54c9e8",tool:"#4f9cff",mission:"#6ea8ff",approval:"#e2ad54",writing:"#48c6d8",speaking:"#72d7ef",completed:"#67dbb0",fallback:"#e2ad54",offline:"#596572",error:"#e36e7c"};
export function CognitiveCore({state,level=0,title,detail,progress}:{state:CoreState;level?:number;title:string;detail:string;progress?:number|null}){
 const ref=useRef<HTMLCanvasElement|null>(null);
 useEffect(()=>{const canvas=ref.current;if(!canvas)return;const ctx=canvas.getContext("2d");if(!ctx)return;let raf=0,last=0,alive=true;const reduced=matchMedia("(prefers-reduced-motion: reduce)").matches;
 const resize=()=>{const box=canvas.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,1.5);canvas.width=Math.max(1,box.width*dpr);canvas.height=Math.max(1,box.height*dpr);ctx.setTransform(dpr,0,0,dpr,0,0)};const observer=new ResizeObserver(resize);observer.observe(canvas);resize();
 const draw=(now:number)=>{if(!alive)return;raf=requestAnimationFrame(draw);if(document.hidden||now-last<33)return;last=now;const w=canvas.clientWidth,h=canvas.clientHeight,cx=w/2,cy=h/2,r=Math.min(w,h)*.225,color=tones[state],active=!["idle","offline"].includes(state),speed=reduced?0:active ? .0018 : .00055,pulse=1+(state==="listening"?Math.min(.14,level*.24):active ? .035 : .018)*Math.sin(now*(active ? .006 : .002));
 ctx.clearRect(0,0,w,h);const glow=ctx.createRadialGradient(cx,cy,3,cx,cy,r*2.2);glow.addColorStop(0,color+"42");glow.addColorStop(.45,color+"12");glow.addColorStop(1,"transparent");ctx.fillStyle=glow;ctx.fillRect(0,0,w,h);
 ctx.save();ctx.translate(cx,cy);ctx.strokeStyle=color+"22";ctx.lineWidth=1;for(const scale of[1.25,1.62,2.02]){ctx.beginPath();ctx.arc(0,0,r*scale,0,Math.PI*2);ctx.stroke()}
 ctx.rotate(now*speed);ctx.strokeStyle=color+"bb";ctx.lineWidth=1.5;for(let i=0;i<3;i++){ctx.beginPath();ctx.arc(0,0,r*(1.27+i*.37),i*1.8,i*1.8+(.7+(i*.17)));ctx.stroke()}
 if(["tool","mission","writing","skill"].includes(state))for(let i=0;i<3;i++){const a=now*.0012+i*Math.PI*2/3,rr=r*1.65;ctx.fillStyle=color;ctx.beginPath();ctx.arc(Math.cos(a)*rr,Math.sin(a)*rr,2.5,0,Math.PI*2);ctx.fill()}
 ctx.rotate(-now*speed);ctx.strokeStyle=color+"88";ctx.lineWidth=2;ctx.beginPath();ctx.arc(0,0,r*pulse,0,Math.PI*2);ctx.stroke();const core=ctx.createRadialGradient(-r*.2,-r*.22,2,0,0,r);core.addColorStop(0,"#eef9ff");core.addColorStop(.12,color);core.addColorStop(.56,"#0b3358");core.addColorStop(1,"#07111d");ctx.fillStyle=core;ctx.shadowColor=color;ctx.shadowBlur=state==="offline"?0:26;ctx.beginPath();ctx.arc(0,0,r*.72*pulse,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;
 if(progress!==null&&progress!==undefined){ctx.strokeStyle="#eaf6ff";ctx.lineWidth=3;ctx.beginPath();ctx.arc(0,0,r*1.02,-Math.PI/2,-Math.PI/2+Math.PI*2*Math.max(0,Math.min(1,progress)));ctx.stroke()}ctx.restore()};
 raf=requestAnimationFrame(draw);return()=>{alive=false;cancelAnimationFrame(raf);observer.disconnect()}},[state,level,progress]);
 return <div className={"cognitive-core state-"+state}><canvas ref={ref}/><div className="core-readout"><span>{state.replaceAll("_"," ")}</span><h2>{title}</h2><p>{detail}</p></div><div className="core-brackets" aria-hidden="true"><i/><i/><i/><i/></div></div>
}
