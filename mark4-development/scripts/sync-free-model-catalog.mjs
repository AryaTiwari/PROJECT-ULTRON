import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const source="https://raw.githubusercontent.com/open-free-llm-api/awesome-freellm-apis/main/README.md";
const response=await fetch(source,{headers:{"User-Agent":"ULTRON-Mark4"}});
if(!response.ok)throw new Error("Catalog HTTP "+response.status);
const markdown=await response.text(),directory=path.join(root,".ultron","catalog");
fs.mkdirSync(directory,{recursive:true});
fs.writeFileSync(path.join(directory,"awesome-freellm-apis.md"),markdown);

const clean=value=>String(value||"").replace(/<[^>]+>/g,"").replace(/[*_`]/g,"").replace(/&nbsp;/g," ").trim();
function block(start,end){const a=markdown.indexOf(start),b=markdown.indexOf(end,a+start.length);return a>=0&&b>a?markdown.slice(a+start.length,b):"";}
function tableRows(text){
  return text.split(/\r?\n/).filter(line=>/^\|.*\|$/.test(line)&&!/^\|\s*-/.test(line))
    .map(line=>line.slice(1,-1).split("|").map(clean)).filter(row=>row.length>2);
}
const providerRows=tableRows(block("<!-- BEGIN_PERMANENT_FREE -->","<!-- END_PERMANENT_FREE -->")).slice(1);
const quickRows=tableRows(block("<!-- BEGIN_QUICK_REF -->","<!-- END_QUICK_REF -->")).slice(1);
const baseUrls=new Map(quickRows.map(row=>[row[0],row[1]]));
const providers=providerRows.map(row=>({provider:row[0],freeModels:Number(String(row[1]).replace(/\D/g,""))||0,verification:row[2],maxContext:row[3],modalities:row[4],baseUrl:baseUrls.get(row[0])||null,status:"candidate"}));

let lastProvider="";
const modelRows=tableRows(block("<!-- BEGIN_BEST_MODELS -->","<!-- END_BEST_MODELS -->")).slice(1);
const models=[];
for(const row of modelRows){
  if(row[0])lastProvider=row[0];
  if(!lastProvider||!row[2])continue;
  models.push({provider:lastProvider,name:row[1],modelId:row[2],maxContext:row[3],rateLimit:row[4],status:"candidate"});
}
const knownStale=new Set(["GitHub Models"]);
for(const provider of providers)if(knownStale.has(provider.provider))provider.status="blocked-stale";
for(const model of models)if(knownStale.has(model.provider))model.status="blocked-stale";

const metadata={source,syncedAt:new Date().toISOString(),sha256:crypto.createHash("sha256").update(markdown).digest("hex"),trust:"candidate-discovery-only",providers,models};
fs.writeFileSync(path.join(directory,"awesome-freellm-apis.json"),JSON.stringify(metadata,null,2));
console.log(`catalog synced: ${metadata.sha256.slice(0,12)} · ${providers.length} providers · ${models.length} candidate models`);
