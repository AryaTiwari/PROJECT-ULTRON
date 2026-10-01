import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temp=fs.mkdtempSync(path.join(os.tmpdir(),"ultron-m4-intelligence-"));
process.env.ULTRON_M4_DATA_ROOT=temp;
const contracts=await import("../src/skill-contracts.mjs");
const runtime=await import("../src/skill-runtime.mjs");
const reflex=await import("../src/local-reflex-engine.mjs");
const intelligence=await import("../src/intelligence-engine.mjs");
const db=await import("../src/db.mjs");

test("skill contracts are immutable, complete operational records",()=>{const rows=contracts.listSkillContracts();assert.ok(rows.length>=20);for(const skill of rows){assert.ok(Object.isFrozen(skill));for(const key of["id","name","description","inputSchema","outputSchema","parameters","permissions","approval","costClass","authentication","sideEffect","executor","verifier","recovery","supportedContextSources","compatibleUpstreamOutputs","compatibleDownstreamInputs"])assert.ok(key in skill,`${skill.id} missing ${key}`);}});

const corpus=[
 ["find 40 india saas companies from apollo","apollo.company.discovery"],
 ["find SaaS companies using Apollo","apollo.company.discovery"],
 ["enrich two pocs in this sheet https://docs.google.com/spreadsheets/d/abc123/edit#gid=7","apollo.contact.enrichment"],
 ["send Sandhya an email about tomorrow's review","email.send"],
 ["research 20 fitness creators","creator.research"],
 ["make a reel for Elevate OS","reel.plan"],
 ["inspect this github repository for a bug","github.code.change"],
 ["research the latest creator economy trends","web.research"],
 ["start another SaaS outreach batch","apollo.company.discovery"],
 ["resume mission mission-123","mission.resume"]
];
test("benchmark corpus selects skills with calibrated local reflex routing",()=>{let correct=0;const rows=[];for(const[prompt,expected]of corpus){const result=runtime.resolveSkillRequest(prompt,{repository:"PROJECT-ULTRON",activeMissionId:"mission-123"});rows.push({prompt,expected,actual:result.contract?.id,confidence:result.invocation?.selection?.confidence});if(result.contract?.id===expected)correct++;}const accuracy=correct/corpus.length;assert.ok(accuracy>=.9,JSON.stringify({accuracy,rows},null,2));assert.ok(reflex.reflexStatus().metrics.averageLatencyMs<20);});

test("missing parameters continue the same immutable invocation",()=>{const first=runtime.resolveSkillRequest("find SaaS companies using Apollo",{});assert.equal(first.contract.id,"apollo.company.discovery");assert.deepEqual([...first.invocation.missingParameters].sort(),["country","targetCount"]);assert.ok(Object.isFrozen(first.invocation));const second=runtime.continueInvocation(first.invocation,"50, India");assert.equal(second.invocation.invocationId,first.invocation.invocationId);assert.equal(second.invocation.parameters.targetCount,50);assert.deepEqual(second.invocation.parameters.country,["India"]);assert.equal(second.invocation.executionState,"compiled");assert.equal(second.invocation.parameterEvidence.targetCount.source,"user_confirmation");assert.equal(second.invocation.parameters.companyRowDeletionAllowed,false);});

test("missing parameter state survives persistence and resumes the same invocation",()=>{const first=runtime.resolveSkillRequest("find SaaS companies using Apollo",{});runtime.persistInvocation({...first.invocation,missionId:"mission-persisted"});const restored=db.getMissionInvocation("mission-persisted");assert.deepEqual([...restored.missingParameters].sort(),["country","targetCount"]);const next=runtime.continueInvocation(restored,"50, India");assert.equal(next.invocation.invocationId,first.invocation.invocationId);assert.equal(next.invocation.missionId,"mission-persisted");assert.equal(next.invocation.executionState,"compiled");});

test("typed skill plans only link schema-compatible stages",()=>{const result=runtime.resolveSkillRequest("Find 40 India SaaS companies from Apollo, add them to https://docs.google.com/spreadsheets/d/abc123/edit#gid=7, then enrich two POCs",{});assert.deepEqual(result.invocation.plan.map(x=>x.skillId),["apollo.company.discovery","google.sheet.append","apollo.contact.enrichment","google.sheet.update"]);assert.ok(result.invocation.plan.every(x=>x.compatible));});

test("patterns require repeated evidence, respect explicit facts, corrections and project scope",()=>{const one=intelligence.observe({scope:"PROJECT",projectId:"alpha",kind:"preference",subject:"lead-country",value:{value:"India"}}).pattern;assert.ok(one.confidence<=.45);assert.equal(one.status,"observed");for(let i=0;i<4;i++)intelligence.observe({scope:"PROJECT",projectId:"alpha",kind:"preference",subject:"lead-country",value:{value:"India"}});const repeated=intelligence.intelligenceSnapshot({projectId:"alpha"}).patterns.find(x=>x.subject==="lead-country");assert.ok(repeated.confidence>=.7);assert.equal(intelligence.intelligenceSnapshot({projectId:"beta"}).patterns.some(x=>x.subject==="lead-country"),false);const explicit=intelligence.observe({evidenceClass:"EXPLICIT_PREFERENCE",scope:"PROJECT",projectId:"alpha",kind:"preference",subject:"tone",value:{value:"concise"}}).pattern;assert.equal(explicit.status,"confirmed");assert.ok(explicit.confidence>=.88);const corrected=intelligence.recordCorrection({patternId:explicit.id,scope:"PROJECT",projectId:"alpha",kind:"preference",subject:"tone",correctedValue:"detailed"});assert.equal(corrected.pattern.value.value,"detailed");});

test("structured memory is bounded, relevant and never persists secrets",()=>{intelligence.remember({scope:"PROJECT",projectId:"alpha",kind:"lesson",summary:"Apollo batches usually continue with POC enrichment",payload:{apiKey:"fake-secret-value",safe:"workflow"}});intelligence.remember({scope:"PROJECT",projectId:"beta",kind:"lesson",summary:"Unrelated reel color preference",payload:{safe:true}});const rows=intelligence.searchMemory("continue the Apollo lead batch with contacts",{projectId:"alpha"});assert.ok(rows.some(x=>/Apollo/i.test(x.summary)));assert.equal(rows.some(x=>x.projectId==="beta"),false);assert.equal(rows[0].payload.apiKey,"[redacted]");assert.equal(JSON.stringify(intelligence.intelligenceSnapshot({projectId:"alpha"})).includes("fake-secret-value"),false);});

test("purpose graph persists scoped, evidence-backed relationships",()=>{const result=intelligence.linkPurpose({source:{label:"Apollo repair",type:"task"},target:{label:"Client acquisition",type:"goal"},relation:"supports",scope:"PROJECT",projectId:"alpha",evidence:{missionId:"m1"}});assert.equal(result.edge.relation,"supports");const snapshot=intelligence.intelligenceSnapshot({projectId:"alpha"});assert.ok(snapshot.purpose.edges.some(x=>x.relation==="supports"));});
