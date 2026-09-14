#!/usr/bin/env node
'use strict';
// Real HTTP server and domain controller; acquisition/output are substituted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.ULTRON_M3_PORT = '0';
process.env.ULTRON_M3_LINKEDIN_AUTOSTART = '0';
const config = require('../core/config');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ultron-http-route-'));
config.projectRoot = temp;
// Test persistence must never touch the user's conversation, leads or audio.
for (const [key, value] of Object.entries(config)) {
  if (/(?:Path|Dir)$/.test(key) && typeof value === 'string' && path.isAbsolute(value)) config[key] = path.join(temp, key, path.basename(value));
}
const control = require('../core/command-control-plane');
const id = 'a2ef9454-42a0-41f0-abe7-f4ed93a9d6aa';
const prompt = `Resume LinkedIn mission ${id}.
Immediately perform all work that requires ZERO fresh LinkedIn calls.
Make the canonical Final Master reach exactly 30 verified unique companies.
Maharashtra or Bengaluru, maximum 1000 employees. Remote preferred, not mandatory. No Apollo.
Report: MCP health, cached search responses, cached job details, cache verified companies, Final Master total, nextEligibleAt.`;
const counts = { assistant: 0, models: 0, artifacts: 0, publicResearch: 0, liveLinkedIn: 0, controller: 0 };
function forbidden(key) { return () => { counts[key]++; throw new Error(`Forbidden HTTP path: ${key}`); }; }
require('../core/assistant').handle = forbidden('assistant');
require('../core/integrations').chat = forbidden('models');
require('../core/proactive').start = () => {};
require('../core/voice-orchestrator').enqueue = async () => {};
const media = require('../core/multimodal');
media.attachmentContext = forbidden('artifacts');
media.generate = forbidden('artifacts');
require('../core/research-agent').run = forbidden('publicResearch');
const controller = require('../core/linkedin-domain-controller');
const realHandle = controller.handle;
controller.handle = (...args) => { counts.controller++; return realHandle(...args); };
const runner = require('../core/linkedin-mission-runner');
const operator = require('../core/linkedin-account-operator');
operator.run = async request => {
  const cached = await runner.call('get_job_details', { job_id: '123456789' }, forbidden('liveLinkedIn'));
  assert.equal(cached.title, 'SAP Consultant');
  throw Object.assign(new Error('Live calls wait for safety; cached evidence was processed'), {
    code: 'LINKEDIN_HOURLY_CAP', cooldownUntil: new Date(Date.now() + 3600000).toISOString()
  });
};
const dir = path.join(temp, '.ultron', 'linkedin-missions');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, status: 'partial', createdAt: new Date().toISOString(),
  prepared: { type: 'run', request: { entityMode: 'company', topic: 'SAP', filters: {}, count: 30 }, headers: [] },
  calls: 0, cacheHits: 0, responses: {
    [JSON.stringify(['search_jobs', { keywords: 'SAP' }])]: { at: Date.now(), value: { job_ids: ['123456789'] } },
    [JSON.stringify(['get_job_details', { job_id: '123456789' }])]: { at: Date.now(), value: { title: 'SAP Consultant' } }
  }, progress: {}, followups: [] }));
// No preload or wrapper installation: test the first request startup race.
const server = require('../server');
async function post(message, extra = {}) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, ...extra, history: [{ role: 'user', content: 'Create a DOCX report' }] })
  });
  assert.equal(response.status, 200);
  return response.json();
}
(async () => {
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const result = await post(prompt);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.routing.domain, 'linkedin');
  assert.equal(result.routing.exclusive, true);
  assert.equal(result.routing.controller, 'linkedin-domain-controller');
  assert.equal(result.provider, 'linkedin-account-mcp');
  assert.equal(result.model, 'linkedin-account-operator');
  assert.equal(result.linkedinBackgroundMission.id, id);
  for (let i = 0; i < 100 && runner.get(id).status !== 'waiting_safety'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(runner.get(id).status, 'waiting_safety');
  assert.equal(runner.get(id).cacheHits, 1);
  assert.equal(runner.get(id).prepared.request.savedDiscoveryOnly, true);
  assert.ok(runner.get(id).notBefore);
  assert.equal(counts.controller, 1);
  const oldClient = await post('create a DOCX report', { originalMessage: 'LinkedIn mission progress' });
  assert.equal(oldClient.routing.domain, 'linkedin');
  assert.equal(oldClient.linkedinBackgroundMission.id, id);
  for (const key of ['assistant', 'models', 'artifacts', 'publicResearch', 'liveLinkedIn']) assert.equal(counts[key], 0, key);
  for (const text of [prompt, 'Build my LinkedIn Final Master and report cache statistics', 'Resume LinkedIn mission and report the mission status', 'Hey Ultron, Linked in MCP status', 'Resume LinkedIn mission and then create a PDF report']) {
    assert.equal(control.claim(text).exclusive, true, text);
    assert.equal(media.generationIntent(text), null);
  }
  assert.equal(control.claim('Create a PDF report from my completed LinkedIn mission.').domain, 'artifact');
  assert.equal(media.generationIntent('Create a PDF report from my completed LinkedIn mission.').kind, 'pdf');
  await assert.rejects(require('../core/model-router').chat({ messages: [{ role: 'user', content: prompt }] }), { code: 'LINKEDIN_ROUTE_INVARIANT_VIOLATION' });
  await assert.rejects(control.runExclusive(() => require('../core/direct-provider-router').chat({ model: 'nvidia/nemotron-3-super-120b-a12b', messages: [] })), { code: 'LINKEDIN_ROUTE_INVARIANT_VIOLATION' });
  await assert.rejects(control.runExclusive(() => require('../core/omniroute-fallback').ensure()), { code: 'LINKEDIN_ROUTE_INVARIANT_VIOLATION' });
  console.log('Actual POST /api/chat regression passed:', JSON.stringify({ route: result.routing, model: result.model, provider: result.provider, taskType: result.taskType, status: runner.get(id).status, cacheHits: 1, counts }));
  // Explicit PDF takes the actual HTTP artifact branch, not the domain controller.
  const beforePdf = counts.controller;
  media.attachmentContext = async () => ({ files: [], text: '' });
  media.generate = async intent => { assert.equal(intent.kind, 'pdf'); return { model: 'test-document-composer', provider: 'test', artifacts: [] }; };
  const pdf = await post('Create a PDF report from my completed LinkedIn mission.');
  assert.equal(pdf.taskType, 'artifact-generation');
  assert.equal(counts.controller, beforePdf);
  server.close();
  fs.rmSync(temp, { recursive: true, force: true });
  process.exit(0);
})().catch(error => { console.error(error); server.close(); fs.rmSync(temp, { recursive: true, force: true }); process.exit(1); });
