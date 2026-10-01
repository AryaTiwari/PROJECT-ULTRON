import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {performance} from "node:perf_hooks";

process.env.ULTRON_M4_DATA_ROOT=fs.mkdtempSync(path.join(os.tmpdir(),"ultron-m4-benchmark-"));
const {resolveSkillRequest}=await import("../services/gateway/src/skill-runtime.mjs");
const {reflexStatus}=await import("../services/gateway/src/local-reflex-engine.mjs");
const corpus=[
 {text:"find 40 india saas companies from apollo",skill:"apollo.company.discovery",parameters:{targetCount:40,country:["India"]}},
 {text:"find SaaS companies using Apollo",skill:"apollo.company.discovery",missing:["country","targetCount"]},
 {text:"enrich two pocs in this sheet https://docs.google.com/spreadsheets/d/abc123/edit#gid=7",skill:"apollo.contact.enrichment",parameters:{spreadsheetId:"abc123",sheetId:7}},
 {text:"continue",skill:"mission.resume",context:{activeMissionId:"mission-123"}},
 {text:"Leads",skill:"apollo.company.discovery",allowReflex:true},
 {text:"send Sandhya an email about the review",skill:"email.send",parameters:{recipient:"Sandhya"}},
 {text:"research 20 fitness creators",skill:"creator.research",parameters:{targetCount:20}},
 {text:"make a reel for Elevate OS",skill:"reel.plan"},
 {text:"check my previous Apollo mission",skill:"mission.inspect",allowReflex:true},
 {text:"start another SaaS outreach batch",skill:"apollo.company.discovery"}
];
const cpuStart=process.cpuUsage(),rssStart=process.memoryUsage().rss,started=performance.now(),rows=[];let skillCorrect=0,paramChecks=0,paramCorrect=0,missingChecks=0,missingCorrect=0,escalations=0;
for(let round=0;round<20;round++)for(const item of corpus){const start=performance.now(),result=resolveSkillRequest(item.text,{repository:"PROJECT-ULTRON",...(item.context||{})}),actual=result.contract?.id||null;if(actual===item.skill)skillCorrect++;for(const[key,wanted]of Object.entries(item.parameters||{})){paramChecks++;if(JSON.stringify(result.invocation?.parameters?.[key])===JSON.stringify(wanted))paramCorrect++;}if(item.missing){missingChecks++;if(JSON.stringify([...(result.invocation?.missingParameters||[])].sort())===JSON.stringify([...item.missing].sort()))missingCorrect++;}if(result.escalationRequired)escalations++;if(round===0)rows.push({command:item.text,expectedSkill:item.skill,selectedSkill:actual,confidence:result.invocation?.selection?.confidence??0,missing:result.invocation?.missingParameters||[],latencyMs:Number((performance.now()-start).toFixed(3))});}
const elapsedMs=performance.now()-started,cpu=process.cpuUsage(cpuStart),calls=corpus.length*20,status=reflexStatus(),report={suite:"ULTRON Mark 4 Local Reflex benchmark",kind:"deterministic in-process benchmark; no provider calls",commands:calls,skillSelectionAccuracy:Number((skillCorrect/calls*100).toFixed(2)),parameterAccuracy:paramChecks?Number((paramCorrect/paramChecks*100).toFixed(2)):null,missingParameterAccuracy:missingChecks?Number((missingCorrect/missingChecks*100).toFixed(2)):null,apiFallbackFrequency:Number((escalations/calls*100).toFixed(2)),latency:{totalMs:Number(elapsedMs.toFixed(2)),averageMs:Number((elapsedMs/calls).toFixed(3)),pinnedEngineAverageMs:status.metrics.averageLatencyMs},memory:{rssIncreaseMb:Number(((process.memoryUsage().rss-rssStart)/1024/1024).toFixed(3)),engineVectorMb:status.memoryImpactMb},cpu:{userMs:Number((cpu.user/1000).toFixed(2)),systemMs:Number((cpu.system/1000).toFixed(2))},runtime:status,firstPass:rows};
if(report.skillSelectionAccuracy<90||report.parameterAccuracy<90||report.missingParameterAccuracy<100||report.latency.averageMs>20||report.memory.rssIncreaseMb>32)throw new Error(`INTELLIGENCE_BENCHMARK_REGRESSION ${JSON.stringify(report)}`);
console.log(JSON.stringify(report,null,2));
