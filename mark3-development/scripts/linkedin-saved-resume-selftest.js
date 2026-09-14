const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linkedin-resume-'));
const config = require.resolve('../core/config');
const originalConfig = require(config);
require.cache[config].exports = { ...originalConfig, projectRoot: root };

const runner = require('../core/linkedin-mission-runner');
const compiler = require('../core/linkedin-mission-contract');

async function until(fn) {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out');
}

(async () => {
  runner.start(async () => {
    await runner.call('search_jobs', { keywords: 'SAP' }, async () => ({
      job_ids: ['4252026496', '4252026497'],
    }));
    throw Object.assign(new Error('timed out'), { code: 'LINKEDIN_MCP_TIMEOUT' });
  });

  const initial = runner.enqueue({
    request: {
      entityMode: 'company',
      topic: 'SAP',
      count: 30,
      filters: { workType: 'remote' },
    },
  });

  await until(() => runner.get(initial.id).status === 'failed');

  const saved = runner.get(initial.id);
  saved.status = 'partial';
  saved.research = { records: [] };
  fs.writeFileSync(
    path.join(root, '.ultron', 'linkedin-missions', `${initial.id}.json`),
    JSON.stringify(saved),
  );

  let freshSearchCalls = 0;
  runner.start(async (prepared) => {
    assert.equal(prepared.request.resumeExistingPool, true);
    const result = await runner.call(
      'search_jobs',
      { keywords: 'SAP', location: 'Bengaluru' },
      async () => {
        freshSearchCalls++;
        throw new Error('Fresh search forbidden');
      },
    );
    assert.deepEqual(
      require('../core/linkedin-account-operator').jobIdsFromResult(result),
      ['4252026496', '4252026497'],
    );
    return { text: 'done' };
  });

  const text = 'Resume the failed LinkedIn SAP mission. Maharashtra or Bengaluru. remote preferred, not mandatory. maximum 1000 employees. Continue toward 30 unique verified companies TOTAL.';
  const resumed = runner.resumeSaved(text);
  assert.equal(resumed.id, initial.id);

  await until(() => runner.get(initial.id).status === 'completed');

  const completed = runner.get(initial.id);
  assert.equal(runner.list().length, 1);
  assert.equal(freshSearchCalls, 0);
  assert.ok(completed.cacheHits >= 1);
  assert.equal(completed.discoveryReplayed, true);
  assert.ok(
    Array.isArray(completed.discoverySourceMissionIds)
      ? completed.discoverySourceMissionIds.includes(initial.id)
      : completed.discoverySourceMissionId === initial.id,
  );
  assert.equal(compiler.workType(text).strictness, 'preference');

  const missingId = 'a2ef9454-42a0-41f0-abe7-f4ed93a9d6aa';
  const recoveryText = `Resume LinkedIn mission ${missingId} from saved evidence. Target 30 unique SAP-hiring companies total, Maharashtra or Bengaluru, maximum 1000 employees; remote preferred. No Apollo.`;
  const recovery = runner.resumeSaved(recoveryText);
  assert.equal(recovery.recovered, true);
  assert.equal(recovery.missingMissionId, missingId);
  assert.notEqual(recovery.id, missingId);
  assert.ok(recovery.recoverySourceMissionIds.includes(initial.id));
  assert.equal(recovery.freshDiscoveryAllowed, false);

  const recoveryMission = runner.get(recovery.id);
  assert.equal(recoveryMission.prepared.request.resumeExistingPool, true);
  assert.equal(recoveryMission.prepared.request.savedDiscoveryOnly, true);
  assert.equal(recoveryMission.prepared.request.reuseCachedEvidence, true);
  assert.equal(recoveryMission.prepared.request.wantsContacts, false);
  assert.equal(recoveryMission.prepared.request.recoveredFromMissingMissionId, missingId);

  await until(() => runner.get(recovery.id).status === 'completed');

  const resumableRecovery = runner.get(recovery.id);
  resumableRecovery.status = 'partial';
  fs.writeFileSync(
    path.join(root, '.ultron', 'linkedin-missions', `${recovery.id}.json`),
    JSON.stringify(resumableRecovery),
  );

  const beforeTargetedCount = runner.list().length;
  const targeted = runner.resumeSaved(
    `Continue recovery mission ${recovery.id}. Do not create another mission. Reuse the existing saved evidence only.`
  );
  assert.equal(targeted.id, recovery.id);
  assert.equal(runner.list().length, beforeTargetedCount, 'Explicit recovery continuation must not create another mission.');

  await until(() => runner.get(recovery.id).status === 'completed');
  assert.equal(freshSearchCalls, 0);
  const recoveredComplete = runner.get(recovery.id);
  assert.equal(recoveredComplete.discoveryReplayed, true);
  assert.ok(
    Array.isArray(recoveredComplete.discoverySourceMissionIds)
      ? recoveredComplete.discoverySourceMissionIds.includes(initial.id)
      : recoveredComplete.discoverySourceMissionId === initial.id,
  );

  console.log('Saved resume regression passed: exact mission resumes preserve identity; missing explicit IDs recover from compatible saved LinkedIn evidence with zero fresh discovery.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
