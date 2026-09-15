import { REEL_SPEC } from "./recipe.mjs";

const esc=value=>String(value??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&apos;"}[ch]));
function wrap(value,maxChars=22,maxLines=4){
  const words=String(value||"").trim().split(/\s+/).filter(Boolean),lines=[];let line="";
  for(const word of words){
    const next=line?line+" "+word:word;
    if(next.length>maxChars&&line){lines.push(line);line=word;if(lines.length>=maxLines-1)break;}else line=next;
  }
  if(line&&lines.length<maxLines)lines.push(line);
  return lines;
}
function textBlock(lines,{x=72,y=500,size=86,line=1.04,weight=700,fill=REEL_SPEC.palette.white,anchor="start"}={}){
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="Inter,Segoe UI,Arial,sans-serif" font-size="${size}" font-weight="${weight}" fill="${fill}">${lines.map((t,i)=>`<tspan x="${x}" dy="${i?size*line:0}">${esc(t)}</tspan>`).join("")}</text>`;
}
function retention(points=[]){
  const values=points.length?points:[100,82,69,56,48,43];
  const left=90,top=1020,width=900,height=360;
  const coords=values.map((v,i)=>[left+i*(width/Math.max(1,values.length-1)),top+height-(v/100)*height]);
  const line=coords.map((p,i)=>(i?"L":"M")+p[0].toFixed(1)+" "+p[1].toFixed(1)).join(" ");
  return `<g><rect x="${left}" y="${top}" width="${width}" height="${height}" rx="30" fill="#071421" stroke="#173A5D"/>
    ${[25,50,75].map(v=>`<line x1="${left+22}" x2="${left+width-22}" y1="${top+height-(v/100)*height}" y2="${top+height-(v/100)*height}" stroke="#17324D" stroke-width="2"/>`).join("")}
    <path d="${line}" fill="none" stroke="#56A5FF" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>
    ${coords.map(p=>`<circle cx="${p[0]}" cy="${p[1]}" r="10" fill="#F3F8FF" stroke="#2F86FF" stroke-width="6"/>`).join("")}</g>`;
}
function itemCards(items=[]){
  return items.slice(0,4).map((item,i)=>{
    const y=970+i*178;
    return `<g><rect x="72" y="${y}" width="936" height="142" rx="26" fill="${i===0?"#0B2239":"#071421"}" stroke="#173A5D"/>
      <circle cx="126" cy="${y+71}" r="26" fill="#0E3154"/><text x="126" y="${y+80}" text-anchor="middle" font-family="Inter,Arial" font-size="24" font-weight="700" fill="#79B8FF">${i+1}</text>
      <text x="178" y="${y+82}" font-family="Inter,Segoe UI,Arial" font-size="36" font-weight="600" fill="#EAF4FF">${esc(item)}</text></g>`;
  }).join("");
}
export function sceneSvg(scene,recipe){
  const p=REEL_SPEC.palette;
  const title=wrap(scene.title||recipe.title,scene.type==="hook"?18:23,scene.type==="hook"?4:3);
  const eyebrow=scene.eyebrow||"ELEVATE OS";
  const metric=scene.metric;
  let body="";
  if(scene.type==="metric"){
    body=`<text x="72" y="1110" font-family="Inter,Segoe UI,Arial" font-size="184" font-weight="800" fill="${p.white}">${esc(metric||"2.4×")}</text>
      <text x="78" y="1190" font-family="Inter,Segoe UI,Arial" font-size="34" font-weight="500" fill="${p.blueSoft}">${esc(scene.metricLabel||scene.subtitle)}</text>`;
  }else if(scene.type==="retention"){
    body=retention(scene.points);
  }else if(scene.type==="pillars"||scene.type==="split"){
    body=itemCards(scene.items.length?scene.items:[scene.subtitle].filter(Boolean));
  }else if(scene.type==="cta"){
    body=`<rect x="72" y="1110" width="936" height="154" rx="40" fill="#EAF4FF"/>
      <text x="540" y="1205" text-anchor="middle" font-family="Inter,Segoe UI,Arial" font-size="42" font-weight="750" fill="#06111C">${esc(scene.cta||"Build content that converts")}</text>`;
  }else if(scene.type==="character"){
    body=`<g transform="translate(540 1150)"><circle r="170" fill="#0A1B2C" stroke="#2F86FF" stroke-width="8"/>
      <path d="M-55 -72 L0 -150 L55 -72 L105 100 L-105 100 Z" fill="#0C67D5"/><circle cy="-120" r="48" fill="#EAF4FF"/><rect x="-30" y="-128" width="60" height="12" rx="6" fill="#08111A"/>
      <text y="250" text-anchor="middle" font-family="Inter,Arial" font-size="30" font-weight="600" fill="#79B8FF">${esc(scene.character||"ULTRON")}</text></g>`;
  }else{
    body=scene.subtitle?textBlock(wrap(scene.subtitle,34,5),{x:72,y:1040,size:43,line:1.35,weight:500,fill:p.muted}):"";
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${recipe.width}" height="${recipe.height}" viewBox="0 0 ${recipe.width} ${recipe.height}">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#03070D"/><stop offset=".58" stop-color="#06111C"/><stop offset="1" stop-color="#081B2D"/></linearGradient>
  <radialGradient id="glow"><stop offset="0" stop-color="#2F86FF" stop-opacity=".24"/><stop offset="1" stop-color="#2F86FF" stop-opacity="0"/></radialGradient></defs>
  <rect width="1080" height="1920" fill="url(#bg)"/><circle cx="860" cy="260" r="520" fill="url(#glow)"/>
  <g opacity=".18" stroke="#315B80" stroke-width="1">${Array.from({length:14},(_,i)=>`<line x1="0" x2="1080" y1="${i*140}" y2="${i*140}"/>`).join("")}</g>
  <rect x="72" y="86" width="132" height="42" rx="21" fill="#0A223A" stroke="#1C4B77"/><text x="138" y="114" text-anchor="middle" font-family="Inter,Arial" font-size="18" font-weight="700" fill="#79B8FF">ELEVATE</text>
  <text x="72" y="276" font-family="JetBrains Mono,monospace" font-size="22" font-weight="600" letter-spacing="4" fill="#5785AF">${esc(eyebrow.toUpperCase())}</text>
  ${textBlock(title,{x:72,y:420,size:scene.type==="hook"?104:86,line:1.0,weight:760,fill:p.white})}
  ${body}
  <rect x="72" y="1770" width="936" height="2" fill="#173A5D"/><text x="72" y="1822" font-family="JetBrains Mono,monospace" font-size="18" fill="#527493">ELEVATE OS · CREATOR GROWTH SYSTEM</text>
  <circle cx="985" cy="1815" r="10" fill="#2F86FF"/>
  </svg>`;
}
