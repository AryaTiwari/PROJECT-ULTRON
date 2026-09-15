const TYPES=new Set(["hook","metric","retention","pillars","quote","split","character","cta"]);
const TRANSITIONS=new Set(["fade","wipeleft","slideright","slideleft","smoothleft"]);
export const REEL_SPEC=Object.freeze({
  width:1080,height:1920,fps:30,maxScenes:12,minSceneSeconds:0.65,maxSceneSeconds:6.5,
  palette:{background:"#03070D",surface:"#071421",surface2:"#0B1E31",blue:"#2F86FF",blueSoft:"#79B8FF",white:"#F3F8FF",muted:"#8AA3BA"}
});

const text=value=>String(value??"").replace(/[\u0000-\u001f]/g," ").replace(/\s+/g," ").trim();
const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
function points(value){
  if(!Array.isArray(value))return[];
  return value.map(Number).filter(Number.isFinite).slice(0,20).map(n=>clamp(n,0,100));
}
function strings(value,max=5){
  return Array.isArray(value)?value.map(text).filter(Boolean).slice(0,max):[];
}

export function normalizeRecipe(input={}){
  const rawScenes=Array.isArray(input.scenes)?input.scenes:[];
  if(!rawScenes.length)throw new Error("REEL_REQUIRES_SCENES");
  if(rawScenes.length>REEL_SPEC.maxScenes)throw new Error("REEL_TOO_MANY_SCENES");
  const scenes=rawScenes.map((raw,index)=>{
    const type=TYPES.has(String(raw?.type||""))?String(raw.type):index===0?"hook":index===rawScenes.length-1?"cta":"quote";
    const duration=clamp(Number(raw?.duration||2.4),REEL_SPEC.minSceneSeconds,REEL_SPEC.maxSceneSeconds);
    const transition=TRANSITIONS.has(String(raw?.transition||""))?String(raw.transition):"fade";
    return{
      id:`scene-${String(index+1).padStart(2,"0")}`,
      type,duration:Number(duration.toFixed(2)),transition,
      eyebrow:text(raw?.eyebrow).slice(0,48),
      title:text(raw?.title).slice(0,160),
      subtitle:text(raw?.subtitle).slice(0,240),
      metric:text(raw?.metric).slice(0,48),
      metricLabel:text(raw?.metricLabel).slice(0,80),
      cta:text(raw?.cta).slice(0,80),
      items:strings(raw?.items,5).map(x=>x.slice(0,90)),
      points:points(raw?.points),
      character:text(raw?.character).slice(0,48),
      note:text(raw?.note).slice(0,120)
    };
  });
  const total=scenes.reduce((sum,s)=>sum+s.duration,0);
  return{
    version:1,
    title:text(input.title||"Elevate OS Reel").slice(0,120),
    objective:text(input.objective).slice(0,220),
    width:REEL_SPEC.width,height:REEL_SPEC.height,fps:REEL_SPEC.fps,
    scenes,totalDuration:Number(total.toFixed(2)),
    audioPath:text(input.audioPath||"")||null,
    createdFor:"Elevate OS"
  };
}
