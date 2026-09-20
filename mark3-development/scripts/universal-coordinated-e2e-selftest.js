'use strict';
const assert=require('assert/strict');
require('../core/universal-deterministic-bootstrap').install();
const sheets=require('../core/google-sheets-operator');
sheets.batchValues=async(id,ranges)=>Promise.all(ranges.map(range=>sheets.values(id,range)));
const apollo=require('../core/apollo-enrichment');
const context=require('../core/universal-run-context');
const operator=require('../core/universal-sheet-enrichment-targeted');
const candidates=[
 {id:'p1',name:'First Person',title:'Founder'},
 {id:'p2',name:'Second Person',title:'HR Manager'},
 {id:'p3',name:'Third Person',title:'Senior Recruiter'},
].map((p,i)=>({...p,organizationName:'Acme Systems',organizationDomain:'acme.example',linkedinUrl:'https://www.linkedin.com/in/'+p.id,phone:'+91987654321'+i,email:p.id+'@acme.example',email_status:'verified',identityVerified:true,apolloPersonId:p.id}));
let grid,searches=0,hydrations=0,writes=0;
sheets.metadata=async()=>({properties:{title:'Offline benchmark'},sheets:[{properties:{title:'Leads',sheetId:1}}]});
sheets.values=async(_id,range)=>{const m=range.match(/!(\d+):(\d+)$/);return m?grid.slice(Number(m[1])-1,Number(m[2])).map(r=>r.slice()):grid.map(r=>r.slice());};
sheets.linkedInHyperlinks=async()=>new Map();
sheets.writeCells=async(id,changes)=>{context.commit(id,changes);writes++;for(const change of changes){const m=change.range.match(/!([A-Z]+)(\d+)$/);let column=0;for(const c of m[1])column=column*26+c.charCodeAt(0)-64;grid[Number(m[2])-1][column-1]=change.value;}return {updatedCells:changes.length};};
sheets.readCell=async(_id,range)=>{const m=range.match(/!([A-Z]+)(\d+)$/);let column=0;for(const c of m[1])column=column*26+c.charCodeAt(0)-64;return grid[Number(m[2])-1]?.[column-1]||'';};
apollo.searchCompanyPeopleBroad=async()=>{searches++;context.provider('apollo');return {people:candidates};};
apollo.resolveDecisionMaker=async(candidate)=>{hydrations++;context.provider('apollo');return candidates.find(p=>p.id===candidate.id);};
apollo.resolvePersonByNameCompany=async name=>{hydrations++;return candidates.find(p=>p.name===name);};
apollo.resolvePersonProfile=async url=>candidates.find(p=>p.linkedinUrl===url);
async function main(){
 grid=[['Company','POC 1','Email 1','Phone 1','POC 2','Phone 2','Email 2','POC 3','Email 3','Phone 3'],...Array.from({length:30},()=>['Acme Systems','','','','','','','','',''])];
 let result=await operator.run({sheetUrl:'https://docs.google.com/spreadsheets/d/offline/edit',sheetName:'Leads'},{apolloApproved:true,rowLimit:30,expectedPersonGroups:3,schema:{expectedPersonGroups:3},backgroundPhoneWatcher:false});
 assert.equal(result.completionState,'COMPLETE',JSON.stringify(result.completionGate));
 assert.equal(result.metrics.rowsProcessed,30);
 assert.equal(result.metrics.rowsChanged,30);
 assert.equal(result.metrics.cellsChanged,270);
 assert.equal(result.metrics.newContactsAdded,90);
 assert.equal(result.metrics.phoneCellsFilled,90);
 assert.equal(result.metrics.emailCellsFilled,90);
 assert.equal(searches,1,'shared company discovery');
 assert.equal(hydrations,3,'only three distinct final people hydrated across all rows');
 assert.equal(writes,30,'one batch per row, not one per cell');
 for(const row of grid.slice(1)){assert.ok(row[1].includes('Founder'));assert.ok(row[4].includes('HR Manager'));assert.ok(row[7].includes('Senior Recruiter'));assert.equal(new Set([row[1],row[4],row[7]]).size,3);}
 writes=0;result=await operator.run({sheetUrl:'https://docs.google.com/spreadsheets/d/offline/edit',sheetName:'Leads'},{apolloApproved:true,expectedPersonGroups:3,schema:{expectedPersonGroups:3},backgroundPhoneWatcher:false});
 assert.equal(result.metrics.cellsChanged,0,'rerun must preserve completed rows');assert.equal(writes,0);
 const request={sheetUrl:'https://docs.google.com/spreadsheets/d/offline/edit',sheetName:'Leads'};
 grid=[['Company','Name','Mail ID','Contact No'],['Acme Systems','','','']];
 const searchesBefore=searches;
 await assert.rejects(operator.run(request,{apolloApproved:false}),e=>e.code==='APOLLO_APPROVAL_REQUIRED');
 assert.equal(searches,searchesBefore,'inspection cannot call Apollo');
 await assert.rejects(operator.run(request,{apolloApproved:true,expectedSchemaFingerprint:'changed-layout'}),e=>e.code==='UNIVERSAL_SCHEMA_AMBIGUOUS');
 assert.equal(searches,searchesBefore,'changed approved schema cannot call Apollo');
 result=await operator.run(request,{apolloApproved:true,backgroundPhoneWatcher:false});
 assert.equal(result.completionState,'COMPLETE');assert.equal(grid[1][1],'First Person — Founder');assert.equal(grid[1][2],'p1@acme.example');
 grid=[['Company','Name','Mail ID','Contact No'],['Acme Systems','First Person - Founder','','existing-phone']];
 result=await operator.run(request,{apolloApproved:true,backgroundPhoneWatcher:false});
 assert.equal(grid[1][1],'First Person - Founder');assert.equal(grid[1][3],'existing-phone');assert.equal(grid[1][2],'p1@acme.example');
 grid=[['Company','Name','Mail ID','Contact No'],['Acme Systems','','p1@acme.example','']];
 result=await operator.run(request,{apolloApproved:true,backgroundPhoneWatcher:false});
 assert.equal(grid[1][1],'First Person — Founder','matching orphan receives only the exact hydrated identity');
 const goodSearch=apollo.searchCompanyPeopleBroad;
 apollo.searchCompanyPeopleBroad=async()=>{throw Object.assign(new Error('Apollo rate limit'),{code:'APOLLO_RATE_LIMIT',subsystem:'APOLLO',status:429});};
 grid=[['Company','Name','Email','Phone'],['Acme Systems','','','']];
 result=await operator.run(request,{apolloApproved:true,backgroundPhoneWatcher:false});
 assert.equal(result.completionState,'PARTIAL_PROVIDER_LIMIT');assert.equal(grid[1][1],'');
 apollo.searchCompanyPeopleBroad=goodSearch;
 console.log('End-to-end 30-row benchmark passed: 90 distinct row slots, 270 cells, one shared discovery, three hydrated identities, batch writes and safe rerun.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
