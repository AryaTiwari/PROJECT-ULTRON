const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const WIDTH = 1080;
const HEIGHT = 1920;
const PROVIDER = 'ultron-elevate-asset-pack';
const LICENSE = 'ULTRON generated asset — commercial use permitted';

const CATALOG = Object.freeze([
  { id:'hook-burst', category:'hook', tags:['hook','pattern interrupt','attention','opening'] },
  { id:'creator-workspace', category:'creator', tags:['creator','workspace','laptop','planning','strategy'] },
  { id:'creator-recording', category:'creator', tags:['creator','recording','camera','tripod','reel','filming'] },
  { id:'phone-analytics', category:'analytics', tags:['phone','analytics','views','reach','followers','performance'] },
  { id:'metrics-dashboard', category:'analytics', tags:['metrics','dashboard','views','saves','shares','followers'] },
  { id:'retention-curve', category:'analytics', tags:['retention','watch time','skip','completion','drop off'] },
  { id:'growth-bars', category:'analytics', tags:['growth','scale','followers','reach','increase'] },
  { id:'conversion-funnel', category:'conversion', tags:['conversion','funnel','profile visit','follow','cta'] },
  { id:'profile-journey', category:'conversion', tags:['profile','visit','follow','followers','conversion'] },
  { id:'comparison-split', category:'comparison', tags:['comparison','versus','vs','views','followers','before after'] },
  { id:'before-after', category:'comparison', tags:['before','after','improvement','change','upgrade'] },
  { id:'content-pillars', category:'strategy', tags:['content pillars','strategy','system','repeatable','topics'] },
  { id:'content-calendar', category:'strategy', tags:['calendar','posting','consistency','schedule','content system'] },
  { id:'script-notes', category:'strategy', tags:['script','notes','ideas','planning','hook','cta'] },
  { id:'creator-analytics', category:'analytics', tags:['creator analytics','insights','performance','dashboard','data'] },
  { id:'audience-community', category:'audience', tags:['audience','community','loyal','followers','fans','trust'] },
  { id:'comment-bubbles', category:'audience', tags:['comments','conversation','engagement','interaction','community'] },
  { id:'save-share-signals', category:'audience', tags:['save','share','engagement','signals','value'] },
  { id:'search-discovery', category:'discovery', tags:['search','discovery','seo','keywords','find'] },
  { id:'trend-signal', category:'discovery', tags:['trend','viral','momentum','signal','format'] },
  { id:'reel-preview', category:'creator', tags:['reel','preview','video','short form','instagram'] },
  { id:'creator-profile', category:'creator', tags:['profile','bio','positioning','authority','identity'] },
  { id:'positioning-grid', category:'positioning', tags:['positioning','niche','authority','differentiate','brand'] },
  { id:'brand-readiness', category:'monetization', tags:['brand deal','brand readiness','sponsor','collab','partnership'] },
  { id:'monetization-bars', category:'monetization', tags:['monetization','income','revenue','earn','brand deals'] },
  { id:'collaboration-cards', category:'monetization', tags:['collaboration','brand','campaign','partnership','ugc'] },
  { id:'posting-time', category:'strategy', tags:['posting time','timing','schedule','when to post'] },
  { id:'checklist', category:'strategy', tags:['checklist','steps','action','fix','before you post'] },
  { id:'creator-score', category:'analytics', tags:['score','rating','performance','health','audit'] },
  { id:'retention-heatmap', category:'analytics', tags:['retention','heatmap','drop','attention','watch'] },
  { id:'social-proof', category:'audience', tags:['social proof','comments','results','community','trust'] },
  { id:'cta-endcard', category:'brand', tags:['cta','book','strategy session','elevate os','website'] },
  { id:'premium-grid', category:'background', tags:['generic','premium','background','clean','minimal'] },
  { id:'blue-radial', category:'background', tags:['generic','blue','premium','background'] },
  { id:'dark-lines', category:'background', tags:['generic','dark','motion','background','lines'] },
  { id:'soft-panels', category:'background', tags:['generic','panels','cards','clean','background'] },
]);

const MODE_MAP = Object.freeze({
  'kinetic-hook':'hook-burst',
  'metric-stack':'metrics-dashboard',
  'retention-chart':'retention-curve',
  'growth-chart':'growth-bars',
  'conversion-funnel':'conversion-funnel',
  'comparison-card':'comparison-split',
  'content-pillars':'content-pillars',
  'creator-analytics':'creator-analytics',
  'brand-cta':'cta-endcard',
  'stock-focus':'creator-workspace',
});

function clean(v){return String(v||'').toLowerCase().replace(/\s+/g,' ').trim();}
function clamp(v,min,max){return Math.max(min,Math.min(max,v));}
function color(hex){const value=String(hex).replace('#','');return [parseInt(value.slice(0,2),16),parseInt(value.slice(2,4),16),parseInt(value.slice(4,6),16)];}
function mix(a,b,t){return a.map((v,i)=>Math.round(v+(b[i]-v)*t));}

function crc32(buf){
  let c=0xffffffff;
  for(const byte of buf){c^=byte;for(let k=0;k<8;k+=1)c=(c>>>1)^((c&1)?0xedb88320:0);}
  return (c^0xffffffff)>>>0;
}
function chunk(type,data){
  const typeBuf=Buffer.from(type,'ascii');
  const len=Buffer.alloc(4);len.writeUInt32BE(data.length,0);
  const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(Buffer.concat([typeBuf,data])),0);
  return Buffer.concat([len,typeBuf,data,crc]);
}
function encodePng(width,height,rgb){
  const sig=Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=2;ihdr[10]=0;ihdr[11]=0;ihdr[12]=0;
  const stride=width*3;const raw=Buffer.alloc((stride+1)*height);
  for(let y=0;y<height;y+=1){raw[y*(stride+1)]=0;rgb.copy(raw,y*(stride+1)+1,y*stride,(y+1)*stride);}
  return Buffer.concat([sig,chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw,{level:6})),chunk('IEND',Buffer.alloc(0))]);
}

function canvas(width=WIDTH,height=HEIGHT){
  const rgb=Buffer.alloc(width*height*3);return {width,height,rgb};
}
function px(c,x,y,col){
  if(x<0||y<0||x>=c.width||y>=c.height)return;
  const i=(y*c.width+x)*3;c.rgb[i]=col[0];c.rgb[i+1]=col[1];c.rgb[i+2]=col[2];
}
function gradient(c,top='#070A12',bottom='#111A2C'){
  const a=color(top),b=color(bottom);
  for(let y=0;y<c.height;y+=1){const row=mix(a,b,y/(c.height-1));for(let x=0;x<c.width;x+=1)px(c,x,y,row);}
}
function rect(c,x,y,w,h,col){
  const cc=Array.isArray(col)?col:color(col);const x0=clamp(Math.round(x),0,c.width),x1=clamp(Math.round(x+w),0,c.width);const y0=clamp(Math.round(y),0,c.height),y1=clamp(Math.round(y+h),0,c.height);
  for(let yy=y0;yy<y1;yy+=1){let i=(yy*c.width+x0)*3;for(let xx=x0;xx<x1;xx+=1){c.rgb[i]=cc[0];c.rgb[i+1]=cc[1];c.rgb[i+2]=cc[2];i+=3;}}
}
function line(c,x0,y0,x1,y1,col,thickness=3){
  const cc=Array.isArray(col)?col:color(col);let dx=Math.abs(x1-x0),sx=x0<x1?1:-1,dy=-Math.abs(y1-y0),sy=y0<y1?1:-1,err=dx+dy;
  while(true){rect(c,x0-Math.floor(thickness/2),y0-Math.floor(thickness/2),thickness,thickness,cc);if(x0===x1&&y0===y1)break;const e2=2*err;if(e2>=dy){err+=dy;x0+=sx;}if(e2<=dx){err+=dx;y0+=sy;}}
}
function circle(c,cx,cy,r,col){
  const cc=Array.isArray(col)?col:color(col);for(let y=-r;y<=r;y+=1){const span=Math.floor(Math.sqrt(Math.max(0,r*r-y*y)));rect(c,cx-span,cy+y,span*2+1,1,cc);}
}
function outline(c,x,y,w,h,col,t=4){rect(c,x,y,w,t,col);rect(c,x,y+h-t,w,t,col);rect(c,x,y,t,h,col);rect(c,x+w-t,y,t,h,col);}
function grid(c,step=96,col='#18243A'){
  for(let x=0;x<c.width;x+=step)rect(c,x,0,2,c.height,col);for(let y=0;y<c.height;y+=step)rect(c,0,y,c.width,2,col);
}
function dots(c,step=110,col='#17243C'){for(let y=80;y<c.height;y+=step)for(let x=60;x<c.width;x+=step)circle(c,x,y,3,col);}
function card(c,x,y,w,h,accent=false){rect(c,x,y,w,h,accent?'#16294A':'#111A2B');outline(c,x,y,w,h,accent?'#4E8DFF':'#26344F',3);}
function phone(c,x,y,w,h){rect(c,x,y,w,h,'#090D16');outline(c,x,y,w,h,'#5576A8',8);rect(c,x+w*0.36,y+18,w*0.28,8,'#2E405F');}
function laptop(c,x,y,w,h){rect(c,x,y,w,h,'#0A0F19');outline(c,x,y,w,h,'#42628E',7);rect(c,x-50,y+h+15,w+100,28,'#23324B');}
function camera(c,x,y,w,h){rect(c,x,y,w,h,'#111A29');outline(c,x,y,w,h,'#45658F',6);circle(c,x+w*0.5,y+h*0.5,Math.round(h*0.26),'#223653');circle(c,x+w*0.5,y+h*0.5,Math.round(h*0.13),'#5B8CFF');rect(c,x+w*0.18,y-30,w*0.28,35,'#1B2A42');}
function avatars(c,x,y,cols=4,rows=3){for(let r=0;r<rows;r+=1)for(let k=0;k<cols;k+=1){const cx=x+k*155,cy=y+r*170;circle(c,cx,cy,48,(r+k)%3===0?'#5B8CFF':'#2E4265');rect(c,cx-62,cy+62,124,44,'#16243B');}}

function base(id){const c=canvas();gradient(c,id==='blue-radial'?'#081126':'#070A12',id==='blue-radial'?'#16315A':'#111A2C');return c;}
function renderDesign(id){
  const c=base(id);const blue='#5B8CFF',blue2='#2E66C5',white='#DDE9FF',muted='#26344F';
  if(id==='premium-grid'){grid(c,108,'#101B2E');rect(c,100,320,880,7,blue);rect(c,150,470,780,540,'#0D1524');outline(c,150,470,780,540,'#203451',3);}
  else if(id==='blue-radial'){dots(c,115,'#24416B');circle(c,540,880,260,'#13284A');circle(c,540,880,170,'#183866');circle(c,540,880,90,blue2);}
  else if(id==='dark-lines'){for(let i=0;i<11;i+=1)line(c,0,260+i*140,1080,80+i*140,i%3===0?blue2:'#17233A',4);}
  else if(id==='soft-panels'){for(let i=0;i<5;i+=1)card(c,115,330+i*235,850,170,i===1||i===3);}
  else if(id==='hook-burst'){for(let i=0;i<8;i+=1){const w=14+i*4;rect(c,90+i*120,360,w,880,i%2?blue2:muted);}card(c,160,650,760,390,true);rect(c,160,650,9,390,blue);}
  else if(id==='creator-workspace'){laptop(c,150,610,650,430);phone(c,760,890,190,390);rect(c,120,1380,840,120,'#111A2A');rect(c,160,1420,310,18,blue2);rect(c,160,1460,510,12,muted);}
  else if(id==='creator-recording'){camera(c,270,570,540,330);line(c,540,900,405,1390,muted,12);line(c,540,900,675,1390,muted,12);phone(c,130,1050,230,480);rect(c,730,1050,220,360,'#101A2B');outline(c,730,1050,220,360,blue2,5);}
  else if(id==='phone-analytics'){phone(c,245,360,590,1100);for(let i=0;i<3;i+=1)card(c,305,550+i*230,470,170,i===0);for(let i=0;i<5;i+=1)rect(c,330+i*78,1290-(i*65),48,90+i*65,i===4?blue:blue2);}
  else if(id==='metrics-dashboard'||id==='creator-analytics'){grid(c,120,'#101A2A');for(let i=0;i<3;i+=1)card(c,120,410+i*240,840,185,i===0);for(let i=0;i<5;i+=1)rect(c,190+i*145,1280-(i%3)*80,82,120+(i%3)*80,i===4?blue:blue2);}
  else if(id==='retention-curve'){grid(c,120,'#101A2B');outline(c,120,420,840,860,muted,4);const pts=[[160,560],[300,650],[430,720],[570,845],[720,1040],[910,1190]];for(let i=0;i<pts.length-1;i+=1)line(c,pts[i][0],pts[i][1],pts[i+1][0],pts[i+1][1],blue,12);pts.forEach(p=>circle(c,p[0],p[1],12,white));}
  else if(id==='growth-bars'||id==='monetization-bars'){outline(c,120,430,840,850,muted,4);[190,250,330,430,560,710].forEach((h,i)=>rect(c,170+i*135,1260-h,72,h,i===5?blue:blue2));line(c,170,1110,900,600,white,8);}
  else if(id==='conversion-funnel'){[760,620,480,340].forEach((w,i)=>{const x=(1080-w)/2,y=430+i*240;rect(c,x,y,w,150,i===3?blue: i===2?'#315FA8':'#172B48');outline(c,x,y,w,150,'#426CA7',3);});}
  else if(id==='profile-journey'){phone(c,270,300,540,1180);circle(c,540,560,90,blue2);rect(c,390,700,300,24,white);rect(c,430,755,220,16,muted);rect(c,350,900,380,86,blue);for(let i=0;i<3;i+=1)card(c,340,1050+i*125,400,88,false);}
  else if(id==='comparison-split'||id==='before-after'){rect(c,80,350,430,1040,'#0E1726');rect(c,570,350,430,1040,'#122544');outline(c,80,350,430,1040,muted,4);outline(c,570,350,430,1040,blue2,4);line(c,540,360,540,1370,blue,5);for(let i=0;i<4;i+=1){rect(c,145,520+i*185,300,70,muted);rect(c,635,520+i*185,300,70,i===3?blue:blue2);}}
  else if(id==='content-pillars'){for(let i=0;i<3;i+=1){card(c,140,430+i*330,800,250,i===1);rect(c,185,485+i*330,110,110,i===1?blue:blue2);rect(c,330,500+i*330,460,28,white);rect(c,330,555+i*330,320,18,muted);}}
  else if(id==='content-calendar'){outline(c,120,390,840,1000,muted,4);for(let x=0;x<7;x+=1)rect(c,120+x*120,390,3,1000,muted);for(let y=0;y<6;y+=1)rect(c,120,390+y*166,840,3,muted);for(let i=0;i<10;i+=1)rect(c,150+(i%5)*160,450+Math.floor(i/5)*500,100,34,i%3===0?blue:blue2);}
  else if(id==='script-notes'||id==='checklist'){for(let i=0;i<5;i+=1){card(c,130,370+i*240,820,180,i===0);rect(c,175,425+i*240,46,46,i===0?blue:blue2);rect(c,265,425+i*240,560,22,white);rect(c,265,470+i*240,410,14,muted);}}
  else if(id==='audience-community'||id==='social-proof'){avatars(c,230,440,5,4);}
  else if(id==='comment-bubbles'||id==='save-share-signals'){for(let i=0;i<5;i+=1){const x=i%2?300:130,y=360+i*260,w=i%2?650:720;card(c,x,y,w,170,i===3);circle(c,x+70,y+70,34,i===3?blue:blue2);rect(c,x+130,y+48,w-190,22,white);rect(c,x+130,y+92,w-260,14,muted);}}
  else if(id==='search-discovery'){card(c,120,350,840,120,true);circle(c,190,410,30,blue);line(c,212,432,250,470,blue,10);for(let i=0;i<4;i+=1)card(c,140,560+i*235,800,170,i===0);}
  else if(id==='trend-signal'){grid(c,120,'#101A2B');const pts=[[100,1120],[230,1040],[355,1110],[490,850],[610,920],[760,620],[950,500]];for(let i=0;i<pts.length-1;i+=1)line(c,pts[i][0],pts[i][1],pts[i+1][0],pts[i+1][1],blue,12);pts.forEach(p=>circle(c,p[0],p[1],11,white));}
  else if(id==='reel-preview'){phone(c,260,270,560,1230);rect(c,330,420,420,760,'#14213A');circle(c,540,800,92,blue2);line(c,515,750,515,850,white,12);line(c,515,750,600,800,white,12);line(c,600,800,515,850,white,12);}
  else if(id==='creator-profile'||id==='positioning-grid'){circle(c,540,480,110,blue2);rect(c,330,650,420,34,white);rect(c,395,720,290,18,muted);for(let i=0;i<6;i+=1)card(c,120+(i%2)*430,850+Math.floor(i/2)*220,390,170,i===1||i===4);}
  else if(id==='brand-readiness'||id==='collaboration-cards'){for(let i=0;i<3;i+=1)card(c,120,400+i*330,840,245,i===1);rect(c,175,465+i*330,180,95,i===1?blue:blue2);circle(c,760,520+i*330,52,i===1?blue:'#34537E');line(c,355,512+i*330,710,512+i*330,white,12);}
  else if(id==='posting-time'){circle(c,540,820,300,'#101B2F');circle(c,540,820,282,'#07101E');for(let i=0;i<12;i+=1){const a=i*Math.PI/6;const x=540+Math.sin(a)*245,y=820-Math.cos(a)*245;circle(c,Math.round(x),Math.round(y),8,i%3===0?blue:muted);}line(c,540,820,540,610,white,12);line(c,540,820,700,900,blue,12);}
  else if(id==='creator-score'){circle(c,540,820,310,'#111D31');circle(c,540,820,245,'#09101D');for(let i=0;i<5;i+=1)rect(c,250+i*120,1300-(i*70),70,140+i*70,i===4?blue:blue2);}
  else if(id==='retention-heatmap'){for(let r=0;r<7;r+=1)for(let k=0;k<5;k+=1){const intensity=(r+k)%5;rect(c,150+k*155,400+r*170,115,120,['#14233A','#193154','#244A7A','#315FA8',blue][intensity]);}}
  else if(id==='cta-endcard'){grid(c,108,'#101A2A');card(c,110,470,860,830,true);circle(c,540,650,80,blue);rect(c,250,820,580,38,white);rect(c,335,900,410,22,muted);rect(c,260,1080,560,120,blue);rect(c,335,1240,410,18,white);}
  else{grid(c,108,'#101A2A');card(c,140,470,800,720,true);}
  return c;
}

function scoreAsset(asset,text){let score=0;for(const tag of asset.tags){if(text.includes(tag))score+=tag.length>8?5:3;}return score;}
function resolve(scene={},index=0){
  const mode=clean(scene.visualDesign?.mode);if(MODE_MAP[mode])return CATALOG.find((a)=>a.id===MODE_MAP[mode]);
  const text=clean(`${scene.purpose||''} ${scene.onScreenText||''} ${scene.subText||''} ${scene.narration||''} ${scene.visualQuery||''}`);
  let best=null,bestScore=-1;for(const asset of CATALOG){const s=scoreAsset(asset,text);if(s>bestScore){best=asset;bestScore=s;}}
  if(bestScore<=0)return CATALOG.find((a)=>a.id===['creator-workspace','premium-grid','soft-panels'][index%3]);
  return best;
}

function materialize(scene,destination,options={}){
  const asset=resolve(scene,Number(options.index||0));const c=renderDesign(asset.id);const png=encodePng(c.width,c.height,c.rgb);
  fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,png);
  return {
    ok:true,path:destination,bytes:png.length,provider:PROVIDER,id:asset.id,mediaType:'image',generated:true,
    attribution:`Generated locally by ULTRON Elevate Asset Pack — ${asset.id}`,sourcePage:null,license:LICENSE,commercialUse:true,
    category:asset.category,internalAsset:true,noNetwork:true,
  };
}

function emergencyFilter(scene={}){
  const asset=resolve(scene,0);const accent=asset.category==='monetization'?'0x4E7ED6':asset.category==='conversion'?'0x5B8CFF':'0x345B92';
  return `drawgrid=w=120:h=120:t=2:c=0x152038@0.7,drawbox=x=120:y=420:w=840:h=900:color=0x0D1626@0.92:t=fill,drawbox=x=120:y=420:w=8:h=900:color=${accent}@1:t=fill,vignette=PI/7`;
}

function status(){return{
  implemented:true,provider:PROVIDER,assetCount:CATALOG.length,categories:[...new Set(CATALOG.map((a)=>a.category))],
  resolution:'1080x1920',format:'procedural PNG + FFmpeg motion carrier',networkRequired:false,apiKeyRequired:false,
  commercialUse:true,zeroCost:true,alwaysAvailable:true,emergencyCarrier:true,
};}

module.exports={WIDTH,HEIGHT,PROVIDER,LICENSE,CATALOG,MODE_MAP,resolve,materialize,emergencyFilter,status,encodePng,renderDesign};
