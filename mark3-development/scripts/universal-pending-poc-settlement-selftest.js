#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const bootstrap = require('../core/universal-deterministic-bootstrap');
bootstrap.install();
const apollo = require('../core/apollo-enrichment');
const operator = require('../core/universal-sheet-enrichment-operator');
const context = require('../core/universal-run-context');

(async () => {
  // The real salesforce/oracle/tech layout is D:F for POC-1, G:I for POC-2.
  // These tests use fictitious fixtures. No live Sheet writes or paid APIs.
  const row = ['Example India Hiring', 'Tech roles', 'https://linkedin.com/company/example-india','','','','','',''];
  const group = { id:'poc-1', ordinal:1, kind:'person', fields:{
    name:{index:3,header:'1st Poc'},
    email:{index:4,header:'Email'},
    phone:{index:5,header:'Phone'},
  }};
  const item = {group,isAnchor:false,snapshot:{
    empty:true,hasIdentity:false,values:{name:'',email:'',phone:'',linkedin:''},
  }};
  const plan={ anchor:{type:'company'},context:{company:'Example India Hiring'},
    groups:{open:[item],partial:[],existing:[],complete:[]}};
  const candidate={
    id:'fixture-person-1',apolloPersonId:'fixture-person-1',
    name:'Example Recruiter',title:'Talent Acquisition Head',
    linkedinUrl:'https://www.linkedin.com/in/fixture-recruiter/',
    organizationName:'Example India Hiring',
    country:'India',
  };
  const companyContext={company:'Example India Hiring',domain:''};
  const originalResolve=apollo.resolveDecisionMaker;
  const nativePending={...candidate,identityVerified:true,
    phone:null,email:'recruiter@example.in',phoneStatus:'pending',
    phoneRequestId:'fixture-phone-request-1'};
  const options=(pendingPhoneQueue=[])=>({
    ordinal:1,rowNumber:2,pendingPhoneQueue,
    contactabilityShortlist:[candidate],
    phoneSettlementPolls:0,maxHydrationAttempts:1,
    fetchPhoneResults:async()=>[],
    pollNativePhone:async()=>({state:'pending'}),
  });

  try {
    apollo.resolveDecisionMaker=async()=>({...nativePending});
    const queue=[];
    const stats=operator.freshStats();
    const staged=await operator.fillManualPriorityGroup(row,plan,companyContext,[candidate],stats,options(queue));
    assert.equal(staged.pending,true,'verified pending candidate must not be discarded as terminal exhaustion');
    assert.equal(staged.filled,false,'a pending phone must not count as a completed POC');
    assert.equal(stats.pendingPocIdentityStaged,1);
    assert.equal(queue.length,1,'the paid callback must have exact row/POC/person ownership');
    assert.equal(queue[0].rowNumber,2);
    assert.equal(queue[0].groupOrdinal,1);
    assert.equal(queue[0].columnIndex,5);
    assert.equal(queue[0].apolloPersonId,'fixture-person-1');
    assert.ok(staged.writes.some(write=>write.field==='name'));
    assert.ok(staged.writes.some(write=>write.field==='email'));
    assert.ok(!staged.writes.some(write=>write.field==='phone'),'never invent a phone for pending data');

    // A terminal no-phone result is not allowed to occupy a new POC slot.
    apollo.resolveDecisionMaker=async()=>({...nativePending,phoneStatus:'not_found',phoneRequestId:''});
    const terminalQueue=[];
    const terminalStats=operator.freshStats();
    const terminal=await operator.fillManualPriorityGroup(row,plan,companyContext,[candidate],terminalStats,options(terminalQueue));
    assert.equal(terminal.pending,undefined);
    assert.equal(terminal.filled,false);
    assert.equal(terminal.writes.length,0);
    assert.equal(terminalQueue.length,0);
    assert.equal(terminal.reason,'contactability-top3-exhausted');

    // Concurrent phone settlements must not re-fetch the same /results snapshot
    // once for every candidate. A requested fresh read remains possible.
    await context.run({},async()=>{
      let requests=0;
      const read=async()=>{requests++;return [{apollo_person_id:'fixture-person-1',phone:'+919876543210'}];};
      const outcomes=await Promise.all(Array.from({length:20},()=>operator.readSharedPhoneResults(read)));
      assert.equal(requests,1,'twenty concurrent candidates should share one callback snapshot');
      assert.equal(outcomes.length,20);
      await operator.readSharedPhoneResults(read,{forceFresh:true});
      assert.equal(requests,2,'later fresh callback reads must remain possible');
    });

    // Existing named POC-2 already has an owned, pending paid phone reveal.
    // Contact repair must not purchase the same phone or replace the person.
    const namedPoc2 = {
      group: { id: 'poc-2', ordinal: 2, kind: 'person', fields: {
        name: {index:6,header:'2nd POC'},
        email: {index:7,header:'Email'},
        phone: {index:8,header:'Phone'},
      }},
      isAnchor: false,
      snapshot: { empty:false, hasIdentity:true, values: {
        name:'Existing Recruiter — Talent Acquisition Head',
        email:'existing@example.in', phone:'', linkedin:'',
      }},
    };
    const originalByName = apollo.resolvePersonByNameCompany;
    apollo.resolvePersonByNameCompany = async () => {
      throw new Error('Already-pending phone must not trigger another Apollo lookup');
    };
    try {
      const awaitingStats = operator.freshStats();
      const awaitingWrites = await operator.repairExistingGroups(
        ['Example India Hiring','Tech','', '', '', '',namedPoc2.snapshot.values.name,
          namedPoc2.snapshot.values.email,''],
        { groups: { partial:[namedPoc2], existing:[namedPoc2] } },
        {company:'Example India Hiring',domain:''},
        awaitingStats,
        {rowNumber:2,pendingPhoneTargets:new Set(['2:2'])}
      );
      assert.deepEqual(awaitingWrites, [], 'pending POC must remain unchanged');
      assert.equal(awaitingStats.existingPhoneAwaitingCallback, 1);
    } finally {
      apollo.resolvePersonByNameCompany = originalByName;
    }

    console.log('Pending POC settlement regression passed: staged verified owner + email, exact durable callback coordinates, no fabricated phone, terminal no-phone rejection, and one shared callback read across 20 candidates.');
  } finally {
    apollo.resolveDecisionMaker=originalResolve;
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
