import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { compileCommand } from "../src/command-control-plane.mjs";
import { APOLLO_ORGANIZATION_SEARCH_ENDPOINT,searchApolloOrganizations } from "../../capability-host/src/apollo-organizations.mjs";
import { createApolloCompanyMissionRunner } from "../src/apollo-company-mission.mjs";
import { selectGoogleSheet } from "../../capability-host/src/workspace.mjs";

const acceptance=`google sheet url https://docs.google.com/spreadsheets/d/1KZKJAe-QqZcreG3mr32JNbdiwBYDFWndynaXqid8wKY/edit?gid=1229007269#gid=1229007269
worksheet - Arya-24 sept
find me 40 india based saas product companies from apollo and fill this sheet`;
const intent=compileCommand(acceptance);
const waitFor=async(check,ms=2500)=>{const start=Date.now();while(Date.now()-start<ms){const value=check();if(value)return value;await new Promise(r=>setTimeout(r,10));}throw new Error("WAIT_TIMEOUT");};
function memoryDb(){const data=new Map(),events=[];return{events,createMission(input){const row={...input,state:input.state||{},constraints:input.constraints||{},completionCriteria:input.completionCriteria||{},strategy:input.strategy||{},artifacts:input.artifacts||[],blockers:input.blockers||[],approvals:input.approvals||[]};data.set(row.id,row);return row;},getMission(id){return data.get(id)||null;},updateMission(id,patch){const old=data.get(id);if(!old)return null;const row={...old,...patch,state:patch.state?{...old.state,...patch.state}:old.state,constraints:patch.constraints?{...old.constraints,...patch.constraints}:old.constraints,completionCriteria:patch.completionCriteria?{...old.completionCriteria,...patch.completionCriteria}:old.completionCriteria};data.set(id,row);return row;},addEvent(event){events.push(event);return event;}};}
function fixture({failAppendOnce=false,failReadOnce=false}={}){
  const db=memoryDb(),timeline=[],appended=[];let appendFailures=failAppendOnce?1:0,readFailures=failReadOnce?1:0,readbacks=0,apolloCalls=0;
  const workspace={
    async googleSheetPreflight(input){timeline.push("preflight");return{target:{spreadsheetId:input.spreadsheetId,sheetId:1229007269,sheetName:"Arya-24 sept",resolutionMethod:"sheetId"},headers:["COMPANY NAME","COMPANY LINK","POC EMAIL"],values:[["COMPANY NAME","COMPANY LINK","POC EMAIL"],["Existing Co","https://linkedin.com/company/existing",""]],rowCount:1};},
    async googleSheetRead(){timeline.push("read");if(readFailures-- >0)throw Object.assign(new Error("AUTH_REVOKED"),{code:"GOOGLE_AUTH_REQUIRED"});return{values:[["COMPANY NAME","COMPANY LINK","POC EMAIL"],["Existing Co","https://linkedin.com/company/existing",""]]};},
    async googleSheetAppendRows({rows}){timeline.push("append");if(appendFailures-- >0)throw Object.assign(new Error("AUTH_REVOKED"),{code:"GOOGLE_AUTH_REQUIRED"});appended.push(...rows);return{updates:{updatedRows:rows.length}};},
    async googleSheetReadback(){timeline.push("readback");readbacks++;return{values:appended};},
  };
  const companies={
    saas:[{id:"a",name:"Alpha SaaS",domain:"alpha.io",linkedin:"https://linkedin.com/company/alpha",employees:60,country:"India",location:"Bengaluru, India",industry:"Software",keywords:["SaaS","software product"],description:"B2B software platform"}],
    "software product":[{id:"b",name:"Beta Product",domain:"beta.io",linkedin:"https://linkedin.com/company/beta",employees:80,country:"India",location:"Mumbai, India",industry:"Software",keywords:["software product"],description:"cloud product company"}],
    "software platform":[{id:"a",name:"Alpha SaaS",domain:"alpha.io",linkedin:"https://linkedin.com/company/alpha",employees:60,country:"India",location:"India",industry:"Software",keywords:["SaaS"],description:"software platform"}],
  };
  const apollo={async searchApolloOrganizations({keywords,page}){timeline.push("apollo:"+keywords+":"+page);apolloCalls++;return{organizations:page===1?(companies[keywords]||[]):[],callCount:1};}};
  const published=[];const runner=createApolloCompanyMissionRunner({db,publish:(type,payload)=>published.push({type,payload}),workspace,apollo});
  return{db,timeline,appended,published,runner,get readbacks(){return readbacks;},get apolloCalls(){return apolloCalls;}};
}
async function runFixture(options){const f=fixture(options),small={...intent,targetCount:2,filters:{...intent.filters},sheet:{...intent.sheet}};const started=await f.runner.start({sessionId:"session-1",intent:small});assert.equal(started.ok,true);await f.runner.approve(started.runId,{request_id:started.requestId,choice:"once"});return{f,started,mission:await waitFor(()=>{const m=f.db.getMission(started.runId);return ["completed","blocked"].includes(m?.status)?m:null;})};}

test("1 exact acceptance command routes to Apollo company discovery",()=>assert.equal(intent.domain,"apollo-company-discovery"));
test("2 owned route is evaluated before proxyChat",()=>{const source=fs.readFileSync(new URL("../src/server.mjs",import.meta.url),"utf8");assert.ok(source.indexOf("compileCommand")<source.indexOf("function proxyChat"));assert.match(source,/routeChat\(req,res/);});
test("3 native Apollo route does not invoke file search or terminal tools",()=>{const source=fs.readFileSync(new URL("../src/apollo-company-mission.mjs",import.meta.url),"utf8");assert.doesNotMatch(source,/read_file|search_file|terminal|spawn\(|exec\(/);});
test("4 spreadsheet URL parses correctly",()=>assert.equal(intent.spreadsheetId,"1KZKJAe-QqZcreG3mr32JNbdiwBYDFWndynaXqid8wKY"));
test("5 gid is preserved as sheetId",()=>assert.equal(intent.sheetId,1229007269));
test("6 explicit worksheet name is preserved",()=>assert.equal(intent.sheetName,"Arya-24 sept"));
test("7 target count is 40",()=>assert.equal(intent.targetCount,40));
test("8 India is an organization location",()=>assert.deepEqual(intent.country,["India"]));
test("9 SaaS and product concepts are compiled",()=>{assert.ok(intent.companyConcepts.includes("saas"));assert.ok(intent.companyConcepts.includes("software product"));assert.ok(intent.companyConcepts.includes("software platform"));const sized=compileCommand("Apollo search India 25+ employees SaaS companies");assert.equal(sized.employeeMin,25);assert.equal(sized.employeeMax,null);});
test("10 company discovery uses Organization Search, never People Search",async()=>{assert.equal(APOLLO_ORGANIZATION_SEARCH_ENDPOINT,"https://api.apollo.io/api/v1/mixed_companies/search");const old=process.env.APOLLO_API_KEY;process.env.APOLLO_API_KEY="test";let url="";await searchApolloOrganizations({keywords:"saas",fetchImpl:async value=>{url=String(value);return{ok:true,json:async()=>({organizations:[]})};}});if(old===undefined)delete process.env.APOLLO_API_KEY;else process.env.APOLLO_API_KEY=old;assert.match(url,/mixed_companies\/search/);assert.doesNotMatch(url,/mixed_people/);});
test("11 Google preflight occurs before the first paid Apollo call",async()=>{const f=fixture(),started=await f.runner.start({sessionId:"s",intent:{...intent,targetCount:2}});assert.equal(f.apolloCalls,0);assert.equal(f.timeline[0],"preflight");await f.runner.approve(started.runId,{choice:"deny"});});
test("12 one mission approval covers all bounded pages",async()=>{const{f,started,mission}=await runFixture();assert.equal(mission.approvals.length,1);const again=await f.runner.approve(started.runId,{choice:"once"});assert.equal(again.alreadyApproved,true);assert.equal(f.db.getMission(started.runId).approvals.length,1);});
test("13 bounded search broadening uses multiple variants",async()=>{const{f}=await runFixture();assert.ok(new Set(f.timeline.filter(x=>x.startsWith("apollo:")).map(x=>x.split(":")[1])).size>1);});
test("14 Apollo candidates are deduplicated before selection",async()=>{const{mission}=await runFixture();assert.equal(new Set(mission.state.selectedCompanies.map(x=>x.id)).size,mission.state.selectedCompanies.length);});
test("15 existing worksheet is resolved and reused",async()=>{const resolved=selectGoogleSheet([{properties:{sheetId:7,title:"Wrong"}},{properties:{sheetId:1229007269,title:"Arya-24 sept"}}],{sheetId:1229007269,sheetName:"wrong"});assert.equal(resolved.selected.title,"Arya-24 sept");assert.equal(resolved.method,"sheetId");const{mission}=await runFixture();assert.equal(mission.state.sheetTarget.sheetId,1229007269);assert.equal(mission.state.sheetTarget.sheetName,"Arya-24 sept");});
test("16 company discovery writes company-owned fields only",async()=>{const{f}=await runFixture();assert.ok(f.appended.length>=1);assert.ok(f.appended.every(row=>row[0]&&row[1]&&row[2]===""));});
test("17 exact written rows receive readback verification",async()=>{const{f,mission}=await runFixture();assert.equal(f.readbacks,1);assert.equal(mission.state.verifiedRows,f.appended.length);assert.ok(f.published.some(event=>event.type==="verification.completed"));});
test("18 Google interruption during Sheet write resumes without rerunning Apollo",async()=>{const{f,started,mission}=await runFixture({failAppendOnce:true});assert.equal(mission.status,"blocked");const calls=f.apolloCalls;await f.runner.resume(started.runId);const completed=await waitFor(()=>f.db.getMission(started.runId)?.status==="completed"&&f.db.getMission(started.runId));assert.equal(completed.status,"completed");assert.equal(f.apolloCalls,calls);});
test("19 Google interruption after Apollo discovery reuses saved candidates without another paid search",async()=>{const{f,started,mission}=await runFixture({failReadOnce:true});assert.equal(mission.status,"blocked");assert.equal(mission.state.currentStage,"SELECTION");assert.equal(mission.state.discoveryComplete,true);const calls=f.apolloCalls;await f.runner.resume(started.runId);const completed=await waitFor(()=>f.db.getMission(started.runId)?.status==="completed"&&f.db.getMission(started.runId));assert.equal(completed.status,"completed");assert.equal(f.apolloCalls,calls);assert.ok(f.published.some(event=>event.type==="apollo.search.reused"));});
test("20 mission implementation never deletes company rows",()=>{const source=fs.readFileSync(new URL("../src/apollo-company-mission.mjs",import.meta.url),"utf8");assert.doesNotMatch(source,/deleteRows|batchClear|spreadsheets\.values\.clear|clear\(/);});
test("21 ordinary conversation remains generic Hermes conversation",()=>{const result=compileCommand("How should I plan my day?");assert.equal(result.owned,false);assert.equal(result.domain,"general-conversation");});
