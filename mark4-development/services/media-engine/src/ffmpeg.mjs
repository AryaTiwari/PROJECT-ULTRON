import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function run(command,args,{cwd,timeout=120000}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd,windowsHide:true,stdio:["ignore","pipe","pipe"]});
    let stderr="";child.stderr.setEncoding("utf8");child.stderr.on("data",x=>{stderr=(stderr+x).slice(-12000);});
    const timer=setTimeout(()=>{child.kill("SIGKILL");reject(new Error(`${command.toUpperCase()}_TIMEOUT`));},timeout);
    child.on("error",error=>{clearTimeout(timer);reject(error);});
    child.on("close",code=>{clearTimeout(timer);code===0?resolve({stderr}):reject(new Error(`${command} exited ${code}: ${stderr.slice(-3000)}`));});
  });
}
export async function assertMediaTools(){
  await run("ffmpeg",["-version"],{timeout:8000});
  await run("ffprobe",["-version"],{timeout:8000});
  return true;
}
export async function renderClip({pngPath,outputPath,duration,fps=30,width=1080,height=1920}){
  const frames=Math.max(1,Math.round(duration*fps));
  await run("ffmpeg",[
    "-y","-loop","1","-i",pngPath,
    "-vf",`scale=${width}:${height}:flags=lanczos,zoompan=z='min(zoom+0.00065,1.035)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=${fps},format=yuv420p`,
    "-frames:v",String(frames),"-an","-c:v","libx264","-preset","veryfast","-crf","18",outputPath
  ],{cwd:path.dirname(outputPath)});
}
export async function composeClips({clips,scenes,outputPath,fps=30,audioPath=null}){
  if(!clips.length)throw new Error("REEL_NO_CLIPS");
  if(clips.length===1){
    const args=["-y","-i",clips[0]];
    if(audioPath){args.push("-stream_loop","-1","-i",audioPath,"-map","0:v:0","-map","1:a:0","-shortest","-c:a","aac","-b:a","160k");}
    args.push("-c:v","copy",outputPath);await run("ffmpeg",args,{cwd:path.dirname(outputPath)});return;
  }
  const args=["-y"];for(const clip of clips)args.push("-i",clip);
  if(audioPath)args.push("-stream_loop","-1","-i",audioPath);
  const transition=0.18;let cumulative=scenes[0].duration;const filters=[];let previous="[0:v]";
  for(let i=1;i<clips.length;i++){
    const next=`[v${i}]`,offset=Math.max(0.01,cumulative-transition*i);
    const kind=["fade","wipeleft","slideright","slideleft","smoothleft"].includes(scenes[i-1].transition)?scenes[i-1].transition:"fade";
    filters.push(`${previous}[${i}:v]xfade=transition=${kind}:duration=${transition}:offset=${offset.toFixed(3)}${next}`);
    previous=next;cumulative+=scenes[i].duration;
  }
  args.push("-filter_complex",filters.join(";"),"-map",previous);
  if(audioPath){args.push("-map",`${clips.length}:a:0`,"-shortest","-c:a","aac","-b:a","160k");}
  args.push("-r",String(fps),"-c:v","libx264","-preset","veryfast","-crf","18","-pix_fmt","yuv420p","-movflags","+faststart",outputPath);
  await run("ffmpeg",args,{cwd:path.dirname(outputPath),timeout:180000});
}
export async function probeVideo(file){
  const child=spawn("ffprobe",["-v","error","-print_format","json","-show_format","-show_streams",file],{windowsHide:true,stdio:["ignore","pipe","pipe"]});
  let out="",err="";child.stdout.setEncoding("utf8");child.stderr.setEncoding("utf8");child.stdout.on("data",x=>out+=x);child.stderr.on("data",x=>err+=x);
  const code=await new Promise((resolve,reject)=>{child.on("error",reject);child.on("close",resolve);});
  if(code!==0)throw new Error("ffprobe failed: "+err.slice(-2000));
  const data=JSON.parse(out||"{}"),video=(data.streams||[]).find(x=>x.codec_type==="video")||{};
  return{duration:Number(data.format?.duration||0),size:Number(data.format?.size||fs.statSync(file).size),width:video.width||null,height:video.height||null,fps:video.r_frame_rate||null,codec:video.codec_name||null};
}
