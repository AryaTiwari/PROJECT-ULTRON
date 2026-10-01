import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mark4Root, repoRoot } from "./config.mjs";
import { normalizeOutput } from "./attention.mjs";
import { listSkillContracts,publicSkillContract } from "./skill-contracts.mjs";
import { intelligenceSnapshot } from "./intelligence-engine.mjs";
import { reflexStatus } from "./local-reflex-engine.mjs";

function git(args){return execFileSync("git",args,{cwd:repoRoot,encoding:"utf8",windowsHide:true,timeout:3500,maxBuffer:1024*1024}).trim();}
function safeGit(args,fallback=""){try{return git(args);}catch{return fallback;}}
function worktrees(){const raw=safeGit(["worktree","list","--porcelain"]);if(!raw)return[];return raw.split(/\r?\n\r?\n/).map(block=>{const row={path:"",head:"",branch:"detached"};for(const line of block.split(/\r?\n/)){const [key,...rest]=line.split(" ");if(key==="worktree")row.path=rest.join(" ");if(key==="HEAD")row.head=rest.join(" ").slice(0,8);if(key==="branch")row.branch=rest.join(" ").replace("refs/heads/","");}return row;}).filter(row=>row.path);}
export function workspaceState(){try{const root=safeGit(["rev-parse","--show-toplevel"]);if(!root)return{available:false,error:"Git repository unavailable"};const remote=safeGit(["config","--get","remote.origin.url"]);const repository=remote?remote.replace(/\\/g,"/").split("/").at(-1).replace(/\.git$/i,""):path.basename(root);const changes=safeGit(["status","--porcelain=v1"]).split(/\r?\n/).filter(Boolean).slice(0,80).map(line=>{const match=line.match(/^(\S{1,2})\s+(.+)$/)||line.match(/^(.{2})\s(.+)$/);return{code:String(match?.[1]||"?").trim(),path:String(match?.[2]||line)}});const recentCommits=safeGit(["log","-6","--pretty=format:%h%x09%s%x09%cr"]).split(/\r?\n/).filter(Boolean).map(line=>{const[hash,subject,relativeDate]=line.split("\t");return{hash,subject,relativeDate};});return{available:true,repository,root,branch:safeGit(["branch","--show-current"],"detached"),head:safeGit(["rev-parse","--short","HEAD"]),subject:safeGit(["log","-1","--pretty=%s"]),upstream:safeGit(["rev-parse","--abbrev-ref","@{upstream}"],"")||null,dirty:changes.length>0,changes,recentCommits,worktrees:worktrees()};}catch(error){return{available:false,error:String(error?.message||error)};}}
function firstParagraph(text){return text.replace(/^---[\s\S]*?---\s*/,"").split(/\r?\n\s*\r?\n/).map(x=>x.replace(/^#+\s*/gm,"").trim()).find(Boolean)||"Installed capability";}
export function skillRegistry(){const root=path.join(mark4Root,"hermes","skills");if(!fs.existsSync(root))return[];return fs.readdirSync(root,{withFileTypes:true}).filter(x=>x.isDirectory()).map(dir=>{const file=path.join(root,dir.name,"SKILL.md");const text=fs.existsSync(file)?fs.readFileSync(file,"utf8"):"";const title=text.match(/^#\s+(.+)$/m)?.[1]?.trim()||dir.name.replace(/-/g," ");const lower=text.toLowerCase(),approval=/approval|paid|credit|write|publish/.test(lower);const category=/apollo|lead|linkedin/.test(dir.name)?"Growth":/reel|media|creator/.test(dir.name)?"Creative":/google|workspace|sheet/.test(dir.name)?"Workspace":"General";return{id:dir.name,name:title,summary:firstParagraph(text).slice(0,260),source:"Hermes workspace",path:file,available:Boolean(text),category,triggers:(text.match(/(?:trigger|use when)[^.\n]{0,180}/ig)||[]).slice(0,3),inputs:(text.match(/(?:input|requires?)[^.\n]{0,160}/ig)||[]).slice(0,3),outputs:(text.match(/(?:output|returns?|creates?)[^.\n]{0,160}/ig)||[]).slice(0,3),approvalRequired:approval,owner:"Hermes capability host"};}).sort((a,b)=>a.name.localeCompare(b.name));}
export function memoryState(){const file=path.join(mark4Root,"hermes","MEMORY.md");if(!fs.existsSync(file))return{available:false};const stat=fs.statSync(file),text=fs.readFileSync(file,"utf8").replace(/^#.+$/m,"").trim();return{available:true,source:file,excerpt:text.slice(0,700),updatedAt:stat.mtime.toISOString()};}
function asArtifacts(value){
  if(Array.isArray(value))return value;
  if(!value)return[];
  if(typeof value==="string"){try{return asArtifacts(JSON.parse(value));}catch{return[];}}
  if(typeof value==="object"){
    if(Array.isArray(value.items))return value.items;
    return[value];
  }
  return[];
}
export function systemOverview({missions=[],health={},modelFabric=[],integrations=[]}={}){
  const rows=Array.isArray(missions)?missions:[];
  const routes=Array.isArray(modelFabric)?modelFabric:[];
  const artifacts=rows.flatMap(m=>asArtifacts(m?.artifacts).map((artifact,index)=>normalizeOutput({...(artifact&&typeof artifact==="object"?artifact:{value:artifact}),index},m))).slice(0,100);
  const readyRoutes=routes.filter(x=>x?.configured&&!x?.cooling).length;
  const intelligence=intelligenceSnapshot(),structuredSkills=listSkillContracts().map(publicSkillContract),reflexRaw=reflexStatus(),reflex={...reflexRaw,name:reflexRaw.engine,contractCount:structuredSkills.length,cachedVectors:structuredSkills.length,estimatedVectorMemoryMb:reflexRaw.memoryImpactMb};
  return{generatedAt:new Date().toISOString(),workspace:workspaceState(),skills:structuredSkills,legacySkillInstructions:skillRegistry().length,memory:{...memoryState(),structuredCount:intelligence.memory.length},intelligence,purpose:{name:"ULTRON Mark 4",statement:"A local-first personal operating intelligence that turns verified intent into observable, recoverable work.",source:"Mark 4 product architecture",...intelligence.purpose},reflex,outputs:artifacts,artifacts,integrations,services:[{id:"gateway",label:"Mark 4 Gateway",status:"online",detail:"Local API and event hub"},{id:"hermes",label:"Hermes cognition",status:health?.ok?"online":"unavailable",detail:health?.ok?"Session and tool runtime connected":String(health?.error||"Runtime health check failed")},{id:"local-reflex",label:"Local Reflex Engine",status:"ready",detail:`In-process hashed retrieval · ${reflex.dimensions} dimensions · no model process`},{id:"model-fabric",label:"Model broker",status:readyRoutes?"ready":"degraded",detail:`${readyRoutes} routes ready`} ]};
}
