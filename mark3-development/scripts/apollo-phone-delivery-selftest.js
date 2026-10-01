#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const apollo = require('../core/apollo-enrichment');

// Actual Apollo polling envelope has webhook_result, unlike the callback body.
const fixture = {
  request_id: '-1039995589705121900',
  webhook_status: 'success',
  request_type: 'phone',
  webhook_result: {
    status: 'success',
    people: [{ id: 'fictional-123', phone_numbers: [{
      sanitized_number: '+919876543210', raw_number: '+91 98765 43210',
      status_cd: 'valid_number', type_cd: 'work_direct',
    }] }],
  },
};
assert.equal(apollo.preferredPhoneFromPayload(fixture), '+919876543210');
assert.deepEqual(
  {state:apollo.completedPhonePoll(fixture).state, phone:apollo.completedPhonePoll(fixture).phone},
  {state:'found', phone:'+919876543210'},
  'a completed, zero-credit Apollo poll must yield its nested phone',
);
assert.equal(apollo.completedPhonePoll(fixture, 'fictional-123').phone, '+919876543210',
  'exact Apollo owner receives the direct-polled number');
assert.equal(apollo.completedPhonePoll(fixture, 'different-person').state, 'owner_mismatch',
  'a reused request receipt must never assign another person\'s phone to this POC');
assert.equal(apollo.completedPhonePoll({webhook_status:'in_progress'}).state, 'pending');
assert.equal(apollo.completedPhonePoll({webhook_status:'failed'}).state, 'delivery_failed',
  'failed webhook delivery must not be misreported as Apollo having no phone');
assert.equal(apollo.completedPhonePoll({webhook_status:'success', webhook_result:{people:[]}}).state,'not_found');
assert.equal(apollo.requestIdFromRaw('{"request_id":-1039995589705121900}', {request_id:-1039995589705121900}),
  '-1039995589705121900', 'signed 64-bit request IDs must retain original digits');
assert.equal(apollo.requestIdFromRaw(
  '{"request_id":123,"phone_enrichment":{"status":"pending","request_id":"-1039995589705121900"}}',
  {request_id:123,phone_enrichment:{status:'pending',request_id:-1039995589705121900}},
),'123','Apollo result polling uses the TOP-LEVEL request ID, never nested vendor IDs');
assert.equal(apollo.requestIdFromRaw(
  '{"phone_enrichment":{"request_id":"987654321"},"person":{"id":"example"},"request_id":-1039995589705121900}',
  {request_id:-1039995589705121900}
),'-1039995589705121900','nested ID before top-level ID must not corrupt 64-bit polling receipt');
assert.equal(apollo.requestIdFromRaw(
  '{"phone_enrichment":{"request_id":"987654321"},"person":{"id":"example"}}',
  {phone_enrichment:{request_id:'987654321'}}
),'','nested-only enrichment ID is not a pollable native receipt');


assert.equal(apollo.phoneRevealState(true, null, {__requestId:'-1039995589705121900'}), 'pending');
assert.equal(apollo.phoneRevealState(true, null, {
  __requestId:'-1039995589705121900',phone_enrichment:{status:'failed'},
}), 'unavailable','provider-rejected reveal must not stage a POC despite generic request ID');
const source=fs.readFileSync(path.join(__dirname,'../core/apollo-enrichment.js'),'utf8');
assert.match(source,/ULTRON_M3_APOLLO_PHONE_DELIVERY_MODE', 'poll_only'/,
  'native phone reveal should default to independent Apollo result polling');
assert.match(source,/url.searchParams.set\('poll_only', 'true'\)/,
  'poll-only mode must use documented phone result receipt');
assert.match(source,/if \(deliveryMode === 'webhook'\)[\s\S]*?else \{\s*url.searchParams.set\('poll_only'/,
  'Apollo must never receive webhook_url and poll_only together');
assert.equal(apollo.phoneRevealState(true, null, {__requestId:''}), 'unavailable',
  'a matched person without a reveal receipt is not pending');
assert.equal(apollo.phoneRevealState(true, null, {__requestId:'123',phone_enrichment:{status:'skipped'}}),
  'unavailable','a skipped native reveal will not generate a new webhook');
assert.equal(apollo.phoneRevealState(true, '+919876543210', {}), 'found');
assert.equal(apollo.pendingPhoneRequestFresh({phoneStatus:'pending',apolloPersonId:'person-only'}),false);
assert.equal(apollo.sharedNativePhoneReceipt(
  {apolloPersonId:'person-A',phoneRequestId:'same-native-receipt'},
  {people:{
    personA:{apolloPersonId:'person-A',phoneRequestId:'same-native-receipt'},
    personB:{apolloPersonId:'person-B',phoneRequestId:'same-native-receipt'},
  }}
),true,'one individual Apollo phone receipt cannot certify two different people');
assert.equal(apollo.pendingPhoneRequestFresh({
  phoneStatus:'pending',apolloPersonId:'p',phoneRequestId:'-1039995589705121900',
  phoneRequestedAt:new Date().toISOString(),
}),true);
const operatorSource=fs.readFileSync(path.join(__dirname,'../core/universal-sheet-enrichment-operator.js'),'utf8');
assert.match(operatorSource,/const isNativePending = phoneStatus === 'pending' && Boolean\(phoneRequestId\)/,
  'native phone ownership must require an actual Apollo request ID');
const apolloSource=fs.readFileSync(path.join(__dirname,'../core/apollo-enrichment.js'),'utf8');
assert.match(apolloSource,/phone: needPhone \? immediatePhone : \(previous.phone \?\? null\)/,
  'an immediately available person phone must not be discarded while caching');
console.log('Apollo phone delivery regression passed: nested zero-credit results parsed, signed request IDs exact, immediate phones retained, and ID-less pending safely rejected. No API requests, reveals, or Sheet writes.');
