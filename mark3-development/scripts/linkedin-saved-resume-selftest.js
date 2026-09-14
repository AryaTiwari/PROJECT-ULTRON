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

  console.log('Saved resume regression passed: same mission identity, cached LinkedIn discovery replayed, zero fresh search calls.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
