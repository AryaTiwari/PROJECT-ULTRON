'use strict';
const assert=require('assert/strict');
const ctx=require('../core/universal-run-context');
const state=require('../core/universal-completion-state');
const errors=require('../core/spreadsheet-enrichment-errors');
const catalog=require('../core/universal-error-catalog');
const contact=require('../core/universal-contact-normalization');
const schema=require('../core/universal-sheet-schema');
require('../core/universal-deterministic-bootstrap').install();
async function main(){
 let active=0,peak=0;const outcomes=await ctx.settledMap(Array.from({length:19},(_,i)=>i),async i=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,2));active--;if(i===4)throw new Error('row local');return i;});assert.equal(outcomes.length,19);assert.ok(peak<=4);assert.equal(outcomes[4].status,'rejected');assert.equal(outcomes[18].value,18);
 await Promise.all([1,2].map(expected=>ctx.run({},async()=>{for(let i=0;i<expected;i++)ctx.provider('apollo');await new Promise(resolve=>setTimeout(resolve,3));assert.equal(ctx.snapshot().providerCalls.apollo,expected);assert.equal(ctx.ai(),true);assert.equal(ctx.ai(),true);assert.equal(ctx.ai(),true);assert.equal(ctx.ai(),false);})));assert.equal(ctx.current(),undefined);
 const gap={rowNumber:2,groupOrdinal:3,field:'phone'};
 assert.equal(state.decide({completionGate:{complete:true,contactGaps:[gap]},metrics:{pending:[{...gap,kind:'phone'}]}}),'COMPLETE_WITH_PENDING_CONTACTS');
 assert.equal(state.decide({completionGate:{complete:true,contactGaps:[gap,{rowNumber:3,groupOrdinal:3,field:'phone'}]},metrics:{pending:[{...gap,kind:'phone'}]}}),'PARTIAL_WITH_PENDING_CONTACTS','mixed pending and unavailable contacts remain partial until callbacks settle');
 assert.equal(state.decide({completionGate:{complete:false,requiredIdentityIssues:[{rowNumber:4,groupOrdinal:2}],contactGaps:[gap]},metrics:{pending:[{...gap,kind:'phone'}]}}),'PARTIAL_WITH_PENDING_CONTACTS','pending callbacks remain visible even when identity gaps also exist');
 for(const [code,entry]of Object.entries(catalog.catalog)){const normalized=errors.normalize({code,subsystem:entry.subsystem,message:code});assert.equal(normalized.humanTitle,entry.title);const formatted=errors.format(normalized);for(const label of ['Problem:','Explanation:','What to do:'])assert.ok(formatted.includes(label));assert.ok(!formatted.includes(code));}
 assert.equal(errors.normalize({subsystem:'APOLLO',status:429,errorType:'BAD_REQUEST'}).type,'RATE_LIMIT');
 const names=['Name','Person Name','Candidate Name','Contact Name','POC','POC Name','First POC','POC 1','1st POC','Decision Maker','HR Name','Recruiter','Founder Name','Contact Person','Primary Contact','Secondary Contact','Third Contact'];
 for(const name of names){for(const fields of [['Mail ID','Contact No'],['Mobile','Email Address']]){const rows=[['Organization',name,...fields],['Acme','First Person','','']];const found=schema.inferSchema(rows).personGroups[0];assert.equal(found.fields.name.index,1);assert.ok(found.fields.email);assert.ok(found.fields.phone);}}
 const apollo=require('../core/apollo-enrichment');assert.equal(apollo.pendingPhoneRequestFresh({phoneStatus:'pending',apolloPersonId:'paid-person',phoneRequestId:'paid-id',phoneRequestedAt:'2020-01-01'}),true);
 const base=require('../core/universal-sheet-enrichment-operator');
 assert.equal(base.backgroundFirstPendingContacts({},12),false);
 assert.equal(base.backgroundFirstPendingContacts({},13),true);
 assert.equal(base.backgroundFirstPendingContacts({backgroundFirstPendingContacts:true},1),true);
 const originalSearch=apollo.searchCompanyPeopleBroad;let emptySearchCalls=0;
 apollo.searchCompanyPeopleBroad=async()=>{emptySearchCalls++;return {people:[]};};
 const discoveryCache=new Map(),discoveryStats=base.freshStats();
 await base.discoverPriorityPeopleFast({company:'Acme'},discoveryCache,discoveryStats,{linkedinZeroResultFallback:false,publicIndexFallback:false});
 const callsAfterEmptySearch=emptySearchCalls;
 await base.discoverPriorityPeopleFast({company:'Acme'},discoveryCache,discoveryStats,{linkedinZeroResultFallback:false,publicIndexFallback:false});
 assert.equal(emptySearchCalls,callsAfterEmptySearch,'same-run empty deep discovery must be cached');
 apollo.searchCompanyPeopleBroad=originalSearch;
 const sheets=require('../core/google-sheets-operator');const store=require('../core/universal-pending-emails');const quality=require('../core/apollo-three-poc-quality');
 const source={spreadsheetId:'fixture',sheetName:'Leads',schema:{headerRowNumber:1},rows:[['Name','Email'],['First Person','']]};
 const item={key:'2|1',rowNumber:2,columnIndex:1,groupId:'p1',groupOrdinal:1,personName:'First Person',requestId:'paid-email-id',ownerFields:{name:{index:0,header:'Name'},email:{index:1,header:'Email'}}};
 store.put(source,item);assert.equal(store.forSource(source)[0].requestId,'paid-email-id');
 let name='Other Person',writes=0;
 sheets.batchValues=async(_id,ranges)=>ranges.map(range=>[range.endsWith('1:1')?['Name','Email']:[name,'']]);
 sheets.writeCells=async()=>{writes++;return {updatedCells:1};};quality.pollEmailRequest=async id=>{assert.equal(id,'paid-email-id');return {state:'found',email:'first@acme.example'};};
 await base.syncPendingEmailAssignments(source,[],base.freshStats(),{emailWaterfallSyncPolls:0});assert.equal(writes,0);assert.equal(store.forSource(source).length,1,'ownership failure must keep the already-paid request');
 name='First Person';await base.syncPendingEmailAssignments(source,[],base.freshStats(),{emailWaterfallSyncPolls:0});assert.equal(writes,1);assert.equal(store.forSource(source).length,0);
 const guard=require('../core/universal-live-write-guard');
 const sheet={...source,rows:[['Name','Email'],['First Person','']],schema:{headerRowNumber:1,columns:[{index:0,role:'name'},{index:1,role:'email'}],personGroups:[]}};
 sheets.batchValues=async()=>[[['Name','Email']],[['First Person','=IF(TRUE,"","")']]];
 await assert.rejects(guard.writeVerifiedRow(sheet,2,sheet.rows[1],[{range:"'Leads'!B2",value:'first@acme.example'}]),e=>e.code==='UNIVERSAL_LIVE_WRITE_CONFLICT');
 console.log('Architecture regressions passed: bounded concurrency, isolated accounting, whole-run AI cap, precise completion states, full error vocabulary, header aliases, durable callback recovery and formula preservation.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
