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
  const a = runner.enqueue({}); const b = runner.enqueue({});
  assert.equal(a.status, 'created');
  await waitFor(() => runner.get(b.id).status === 'completed');
  assert.equal(maximum, 1); assert.equal(live, 2);
  assert.equal(runner.get(a.id).cacheHits, 1);
  assert.equal(runner.get(a.id).research.records[0].company, 'Acme');
  runner.start(async () => { const e = new Error('cooldown'); e.code = 'LINKEDIN_COOLDOWN'; throw e; });
  const c = runner.enqueue({});
  await waitFor(() => runner.get(c.id).status === 'paused_rate_limit');
  runner.start(async () => ({ text: 'resumed' }));
  runner.control(c.id, 'resume');
  await waitFor(() => runner.get(c.id).status === 'completed');
  assert.throws(() => runner.get('../escape'));

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

  console.log('LinkedIn mission runner tests passed: quick enqueue, serialization, persistent research, call reuse, cooldown pause/resume and automatic safe-window master-target continuation.');
})().catch(error => { console.error(error); process.exitCode = 1; });
