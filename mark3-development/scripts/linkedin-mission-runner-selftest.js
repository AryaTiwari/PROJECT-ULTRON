const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const configPath = require.resolve('../core/config');
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ultron-linkedin-test-'));
require.cache[configPath] = { id: configPath, filename: configPath, loaded: true, exports: { projectRoot } };
const runner = require('../core/linkedin-mission-runner');
const finalMaster = require('../core/linkedin-final-master');
const waitFor = async predicate => {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Test timed out');
};
(async () => {
  let active = 0; let maximum = 0; let live = 0;
  runner.start(async () => {
    active++; maximum = Math.max(maximum, active);
    await runner.call('search_jobs', { query: 'Python' }, async () => { live++; return { jobs: [1] }; });
    await runner.call('search_jobs', { query: 'Python' }, async () => { live++; return {}; });
    await new Promise(resolve => setTimeout(resolve, 10));
    runner.persistResearch({ records: [{ company: 'Acme' }] });
    active--; return { text: 'done' };
  });
  const a = runner.enqueue({ request: { entityMode: 'company', topic: 'Python', count: 5, filters: {} } });
  const duplicateA = runner.enqueue({ request: { entityMode: 'company', topic: 'Python', count: 5, filters: {} } });
  const b = runner.enqueue({ request: { entityMode: 'company', topic: 'Java', count: 5, filters: {} } });
  assert.equal(a.status, 'created');
  assert.equal(duplicateA.id, a.id);
  assert.equal(duplicateA.alreadyActive, true);
  assert.notEqual(b.id, a.id);
  await waitFor(() => runner.get(b.id).status === 'completed');
  assert.equal(maximum, 1); assert.equal(live, 2);
  assert.equal(runner.get(a.id).cacheHits, 1);
  assert.equal(runner.get(a.id).research.records[0].company, 'Acme');
  runner.start(async () => {
    const e = new Error('LinkedIn safety window exhausted');
    e.code = 'LINKEDIN_COOLDOWN_ACTIVE';
    e.cooldownUntil = new Date(Date.now() + 80).toISOString();
    throw e;
  });
  const c = runner.enqueue({});
  await waitFor(() => runner.get(c.id).status === 'waiting_safety');
  assert.ok(runner.get(c.id).progress.nextEligibleAt);
  assert.equal(runner.isSafetyWaitCode('LINKEDIN_BURST_CAP'), true);
  runner.start(async () => ({ text: 'resumed' }));
  await waitFor(() => runner.get(c.id).status === 'completed');
  assert.throws(() => runner.get('../escape'));

  // Cancelling a mission parked in waiting_safety must be immediate so the old
  // mission cannot keep blocking an equivalent replacement until its timer.
  runner.start(async () => {
    const e = new Error('LinkedIn hourly cap');
    e.code = 'LINKEDIN_HOURLY_CAP';
    e.cooldownUntil = new Date(Date.now() + 500).toISOString();
    throw e;
  });
  const parkedPrepared = { request: { entityMode: 'company', topic: 'Ruby', count: 3, filters: {} } };
  const parked = runner.enqueue(parkedPrepared);
  await waitFor(() => runner.get(parked.id).status === 'waiting_safety');
  const cancelled = runner.control(parked.id, 'cancel');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(runner.get(parked.id).notBefore, null);
  runner.start(async () => ({ text: 'replacement complete' }));
  const replacement = runner.enqueue(parkedPrepared);
  assert.notEqual(replacement.id, parked.id);
  assert.notEqual(replacement.alreadyActive, true);
  await waitFor(() => runner.get(replacement.id).status === 'completed');

  // A master-total mission should remain one logical mission across safe
  // batches instead of requiring a human to keep typing "continue".
  let batch = 0;
  runner.start(async prepared => {
    batch++;
    finalMaster.registerRecords([{
      company: 'Auto Continue ' + batch,
      linkedin: 'https://www.linkedin.com/company/auto-continue-' + batch,
      jobUrl: 'https://www.linkedin.com/jobs/view/' + (9000000 + batch),
    }], { missionId: 'auto-batch-' + batch });
    return {
      text: 'batch ' + batch,
      linkedinMission: {
        found: 1,
        requested: 1,
        added: 1,
        budgetStopped: batch === 1 ? 'mission LinkedIn-call budget reached' : null,
        safety: {},
      },
    };
  });
  const auto = runner.enqueue({
    request: {
      targetMode: 'master_total',
      targetTotal: 2,
      autoContinue: true,
      entityMode: 'company',
      topic: 'SAP',
      filters: {},
    },
  });
  await waitFor(() => runner.get(auto.id).status === 'completed');
  assert.equal(batch, 2);
  assert.equal(runner.get(auto.id).continuationCount, 1);
  assert.equal(finalMaster.masterCount(), 2);

  console.log('LinkedIn mission runner tests passed: quick enqueue, equivalent-mission dedupe, serialization, persistent research, call reuse, automatic safety-window waiting/resume, immediate parked-mission cancellation, replacement enqueue and master-target continuation.');
})().catch(error => { console.error(error); process.exitCode = 1; });
