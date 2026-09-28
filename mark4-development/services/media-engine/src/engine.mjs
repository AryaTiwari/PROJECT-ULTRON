import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { normalizeRecipe } from "./recipe.mjs";
import { sceneSvg } from "./svg.mjs";
import { assertMediaTools,renderClip,composeClips,probeVideo } from "./ffmpeg.mjs";
import {REEL_STAGES,progressFor} from "../../gateway/src/workflow-contracts.mjs";

const here=path.dirname(fileURLToPath(import.meta.url));
const defaultRoot=path.resolve(here,"../../../.ultron/reels");
const queue={tail:Promise.resolve(),active:null};

function safeRoot(root=defaultRoot){fs.mkdirSync(root,{recursive:true});return root;}
function jobDir(id,root=defaultRoot){
  if(!/^reel-[a-f0-9]{16,64}$/i.test(String(id)))throw new Error("INVALID_REEL_JOB_ID");
  return path.join(safeRoot(root),id);
}
function readJson(file){return JSON.parse(fs.readFileSync(file,"utf8"));}
function writeJson(file,value){fs.writeFileSync(file,JSON.stringify(value,null,2));}
function updateStatus(dir,patch){
  const file=path.join(dir,"job.json"),current=fs.existsSync(file)?readJson(file):{};
  const next={...current,...patch,updatedAt:new Date().toISOString()};writeJson(file,next);return next;
}
function safeAssets(assets=[]){return (Array.isArray(assets)?assets:[]).map(asset=>{if(!asset||!asset.source||!asset.provenance)throw new Error("REEL_ASSET_PROVENANCE_REQUIRED");return{source:String(asset.source),provenance:String(asset.provenance),license:asset.license?String(asset.license):null};});}
function safeAudio(audioPath){
  if(!audioPath)return null;
  const absolute=path.resolve(audioPath);
  if(!fs.existsSync(absolute)||!fs.statSync(absolute).isFile())throw new Error("REEL_AUDIO_NOT_FOUND");
  return absolute;
}

export function createReelJob(input,{root=defaultRoot}={}){
  const recipe=normalizeRecipe(input),id="reel-"+crypto.randomBytes(12).toString("hex"),dir=jobDir(id,root);
  fs.mkdirSync(path.join(dir,"scenes"),{recursive:true});
  recipe.scenes.forEach((scene,index)=>fs.writeFileSync(path.join(dir,"scenes",`${String(index+1).padStart(2,"0")}.svg`),sceneSvg(scene,recipe)));
  writeJson(path.join(dir,"recipe.json"),recipe);
  const assets=safeAssets(input.assets),previews=recipe.scenes.map((_,index)=>path.join(dir,"scenes",String(index+1).padStart(2,"0")+".svg"));const workflow={brief:input.brief||input.objective||recipe.objective,goal:input.goal||input.objective||recipe.objective,hook:input.hook||recipe.scenes[0]?.title||null,script:input.script||recipe.scenes.map(s=>s.body||s.title).filter(Boolean).join(" "),cta:input.cta||recipe.scenes.at(-1)?.cta||null,visualPlan:input.visualPlan||"Elevate OS vertical visual system",assetPlan:input.assetPlan||[],assets,storyboard:recipe.scenes,previews};
  const job={id,status:"ready",currentStage:"PREVIEW",progress:progressFor(REEL_STAGES,"PREVIEW",{completed:recipe.scenes.length,total:recipe.scenes.length}),workflow,recipePath:path.join(dir,"recipe.json"),previewPaths:previews,outputPath:null,sceneCount:recipe.scenes.length,totalDuration:recipe.totalDuration,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  writeJson(path.join(dir,"job.json"),job);return job;
}
export function getReelJob(id,{root=defaultRoot}={}){
  const dir=jobDir(id,root),file=path.join(dir,"job.json");
  if(!fs.existsSync(file))throw new Error("REEL_JOB_NOT_FOUND");
  return readJson(file);
}
async function executeRender(id,{root=defaultRoot}={}){
  const dir=jobDir(id,root),recipe=readJson(path.join(dir,"recipe.json")),scenesDir=path.join(dir,"scenes"),framesDir=path.join(dir,"frames"),clipsDir=path.join(dir,"clips");
  fs.mkdirSync(framesDir,{recursive:true});fs.mkdirSync(clipsDir,{recursive:true});
  updateStatus(dir,{status:"rendering",currentStage:"RENDER",progress:progressFor(REEL_STAGES,"RENDER",{completed:0,total:recipe.scenes.length}),error:null});await assertMediaTools();
  try{
    const clips=[];
    for(let i=0;i<recipe.scenes.length;i++){
      const n=String(i+1).padStart(2,"0"),svgPath=path.join(scenesDir,n+".svg"),pngPath=path.join(framesDir,n+".png"),clipPath=path.join(clipsDir,n+".mp4");
      await sharp(svgPath,{density:144}).resize(recipe.width,recipe.height,{fit:"fill"}).png({compressionLevel:8}).toFile(pngPath);
      await renderClip({pngPath,outputPath:clipPath,duration:recipe.scenes[i].duration,fps:recipe.fps,width:recipe.width,height:recipe.height});clips.push(clipPath);updateStatus(dir,{status:"rendering",currentStage:"RENDER",progress:progressFor(REEL_STAGES,"RENDER",{completed:i+1,total:recipe.scenes.length,currentItem:recipe.scenes[i].title||"Scene "+(i+1)})});
    }
    const outputPath=path.join(dir,"final.mp4");
    await composeClips({clips,scenes:recipe.scenes,outputPath,fps:recipe.fps,audioPath:safeAudio(recipe.audioPath)});
    updateStatus(dir,{status:"verifying",currentStage:"QUALITY_CHECK",progress:progressFor(REEL_STAGES,"QUALITY_CHECK",{completed:recipe.scenes.length,total:recipe.scenes.length})});const inspection=await probeVideo(outputPath);const width=Number(inspection.width||inspection.video?.width),height=Number(inspection.height||inspection.video?.height),duration=Number(inspection.duration||inspection.format?.duration||0);if(width&&width!==recipe.width||height&&height!==recipe.height||duration<=0)throw new Error("REEL_QUALITY_CHECK_FAILED");
    return updateStatus(dir,{status:"completed",currentStage:"FINAL_OUTPUT",progress:progressFor(REEL_STAGES,"FINAL_OUTPUT",{completed:recipe.scenes.length,total:recipe.scenes.length}),outputPath,inspection,verified:true});
  }catch(error){
    updateStatus(dir,{status:"failed",error:String(error?.message||error)});
    throw error;
  }
}
export function renderReelJob(id,options={}){
  const task=queue.tail.then(()=>{queue.active=id;return executeRender(id,options);});
  queue.tail=task.catch(()=>{}).finally(()=>{if(queue.active===id)queue.active=null;});
  return task;
}
export async function inspectReelJob(id,{root=defaultRoot}={}){
  const job=getReelJob(id,{root});
  if(!job.outputPath||!fs.existsSync(job.outputPath))return{...job,inspection:null};
  return{...job,inspection:await probeVideo(job.outputPath)};
}
export function mediaEngineStatus(){return{queueConcurrency:1,activeJob:queue.active,engine:"SVG + Sharp + FFmpeg",localLLM:false};}
