#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.ULTRON_M3_PORT = '0';
process.env.ULTRON_M3_LINKEDIN_AUTOSTART = '0';
const config = require('../core/config');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ultron-apollo-http-route-'));
config.projectRoot = temp;
for (const [key, value] of Object.entries(config)) {
  if (/(?:Path|Dir)$/.test(key) && typeof value === 'string' && path.isAbsolute(value)) config[key] = path.join(temp, key, path.basename(value));
}
require('../core/proactive').start = () => {};
require('../core/voice-orchestrator').enqueue = async () => {};
const apollo = require('../core/apollo-enrichment');
let apolloFetches = 0;
apollo.fetchApolloResponse = async () => { apolloFetches++; throw new Error('Apollo must not be called before approval or for progress.'); };
const server = require('../server');
async function post(message) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/chat`, {
    method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({message}),
  });
  assert.equal(response.status,200); return response.json();
}
(async()=>{
  if(!server.listening) await new Promise((resolve)=>server.once('listening',resolve));
  const command='Find me 25 tech product companies. Fill this Google Sheet: https://docs.google.com/spreadsheets/d/example/edit?gid=1566066221, worksheet "Arya". Discovery only. Do not find POCs, emails, or phone numbers.';
  const queued=await post(command);
  assert.equal(queued.routing.domain,'apollo-lead'); assert.equal(queued.approvalRequired,true); assert.equal(queued.apolloCalled,false);
  const status=await post('Apollo lead progress');
  assert.equal(status.routing.domain,'apollo-lead'); assert.equal(status.routing.readOnlyStatus,true); assert.equal(status.approvalRequired,undefined);
  assert.match(status.response,/waiting_approval/i); assert.match(status.response,/Runtime build:/i); assert.equal(apolloFetches,0);
  console.log(`Apollo Lead HTTP routing self-test passed: discovery requested one approval; progress stayed read-only on mission ${status.mission.missionId}; Apollo calls 0.`);
  server.close(); fs.rmSync(temp,{recursive:true,force:true}); process.exit(0);
})().catch((error)=>{console.error(error);server.close();fs.rmSync(temp,{recursive:true,force:true});process.exit(1);});
