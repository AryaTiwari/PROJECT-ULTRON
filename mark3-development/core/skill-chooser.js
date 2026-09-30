'use strict';

const registry=require('./skill-registry');

function text(value){return String(value==null?'':value).trim();}
function extract(message=''){
  const value=text(message);
  const spreadsheet=value.match(/https:\/\/docs\.google\.com\/spreadsheets\/d\/[a-zA-Z0-9_-]+[^\s<>'"`]*/i)?.[0]||null;
  const sheetName=value.match(/\b(?:worksheet|sheet|tab)\s+(?:name\s*)?[:=\-]\s*["'`]?([^\n."'\`]{1,120}?)(?=\s*(?:\.|\n|$))/i)?.[1]?.trim()||null;
  const targetCount=Number(value.match(/\b(?:find|discover|source|get|bring|list)\s+(\d{1,3})\b/i)?.[1]||0)||null;
  const pocs=[...value.matchAll(/\b(?:poc\s*[-#:]?\s*|)([12])(?:st|nd)?\s*(?:poc)?\b/gi)].map(m=>Number(m[1])).filter(n=>n===1||n===2);
  return {spreadsheet,sheetName,targetCount,pocs:[...new Set(pocs)].sort(),provider:/\bapollo\b/i.test(value)?'apollo':/\blinkedin\b/i.test(value)?'linkedin':null};
}
function scoreSkill(skill,message,route={}){
  const value=text(message);
  let score=0;
  let matched=0;
  for(const signal of skill.signals||[]){if(signal.test(value)){score+=1;matched++;}}
  if(route.domain&&route.domain===skill.domain)score+=2.5;
  if(route.controller&&route.controller===skill.controller)score+=1.5;
  return {score,matched};
}
function choose(message,route={},options={}){
  const params=extract(message);
  const ranked=registry.SKILLS.map(skill=>({skill,...scoreSkill(skill,message,route)}))
    .filter(item=>item.score>0)
    .sort((a,b)=>b.score-a.score||b.matched-a.matched||a.skill.id.localeCompare(b.skill.id));
  const top=ranked.slice(0,3);
  const best=top[0]||null;
  const second=top[1]||null;
  const confidence=best?Math.max(0,Math.min(1,best.score/6)):0;
  const margin=best?best.score-Number(second?.score||0):0;
  const missing=best?(best.skill.required||[]).filter(key=>!params[key]):[];
  const ambiguous=Boolean(best&&second&&margin<0.75&&best.skill.domain!==second.skill.domain);
  let question=null;
  if(missing.includes('spreadsheet'))question='Which spreadsheet should I use for this enrichment task?';
  else if(ambiguous)question=`I can route this as ${best.skill.id} or ${second.skill.id}. Which one should own the task?`;
  return {
    selected:best?best.skill.id:null,
    domain:best?.skill.domain||route.domain||null,
    controller:best?.skill.controller||route.controller||null,
    confidence,
    margin,
    parameters:params,
    missingRequired:missing,
    needsUser:Boolean(question),
    question,
    candidates:top.map(item=>({id:item.skill.id,domain:item.skill.domain,score:Number(item.score.toFixed(2))})),
    executionAuthority:false,
    chooser:'deterministic-top-k-v1',
  };
}
module.exports={extract,scoreSkill,choose};
