import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { normalizeRecipe } from "./recipe.mjs";
import { sceneSvg } from "./svg.mjs";
import { assertMediaTools,renderClip,composeClips,probeVideo } from "./ffmpeg.mjs";

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
  const job={id,status:"ready",recipePath:path.join(dir,"recipe.json"),outputPath:null,sceneCount:recipe.scenes.length,totalDuration:recipe.totalDuration,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
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
  updateStatus(dir,{status:"rendering",error:null});await assertMediaTools();
  try{
    const clips=[];
    for(let i=0;i<recipe.scenes.length;i++){
      const n=String(i+1).padStart(2,"0"),svgPath=path.join(scenesDir,n+".svg"),pngPath=path.join(framesDir,n+".png"),clipPath=path.join(clipsDir,n+".mp4");
      await sharp(svgPath,{density:144}).resize(recipe.width,recipe.height,{fit:"fill"}).png({compressionLevel:8}).toFile(pngPath);
      await renderClip({pngPath,outputPath:clipPath,duration:recipe.scenes[i].duration,fps:recipe.fps,width:recipe.width,height:recipe.height});clips.push(clipPath);
    }
    const outputPath=path.join(dir,"final.mp4");
    await composeClips({clips,scenes:recipe.scenes,outputPath,fps:recipe.fps,audioPath:safeAudio(recipe.audioPath)});
    const inspection=await probeVideo(outputPath);
    return updateStatus(dir,{status:"completed",outputPath,inspection});
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
