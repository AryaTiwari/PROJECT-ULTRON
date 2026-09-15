const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ultron-linkedin-cache-only-'));
const configPath = require.resolve('../core/config');
const originalConfig = require(configPath);
require.cache[configPath].exports = {
  ...originalConfig,
  projectRoot,
  mark3Root: projectRoot,
};

const policy = require('../core/linkedin-account-policy');
const mcp = require('../core/linkedin-mcp-client');
const runner = require('../core/linkedin-mission-runner');
const operator = require('../core/linkedin-account-operator');

const missionRoot = path.join(projectRoot, '.ultron', 'linkedin-missions');
fs.mkdirSync(missionRoot, { recursive: true });

const sourceId = '11111111-1111-4111-8111-111111111111';
const source = {
  id: sourceId,
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  updatedAt: new Date(Date.now() - 60_000).toISOString(),
  status: 'partial',
  prepared: {
    request: {
      entityMode: 'company',
      topic: 'SAP',
      hiring: true,
      filters: { employeeMax: 1000 },
    },
  },
  calls: 3,
  cacheHits: 0,
  responses: {
    [JSON.stringify(['search_jobs', { legacy: true }])]: {
      at: Date.now() - 30_000,
      value: { job_ids: ['90000001'] },
    },
    [JSON.stringify(['get_job_details', { job_id: '90000001' }])]: {
      at: Date.now() - 30_000,
      value: {
        url: 'https://www.linkedin.com/jobs/view/90000001',
        sections: {
          job_posting: 'SAP ABAP Consultant\nMumbai, Maharashtra, India\nRemote\nActive SAP ABAP implementation role.',
        },
        references: {
          job_posting: [{
            kind: 'company',
            url: 'https://www.linkedin.com/company/acme-software',
            text: 'Acme Software',
            context: 'job posting',
          }],
        },
      },
    },
    [JSON.stringify(['get_company_profile', { company_name: 'acme-software' }])]: {
      at: Date.now() - 30_000,
      value: {
        url: 'https://www.linkedin.com/company/acme-software',
        sections: {
          main: 'Acme Software\nCompany size: 51-200 employees\nHeadquarters: Mumbai, Maharashtra, India',
        },
        references: {},
      },
    },
  },
  research: null,
  followups: [],
  progress: { phase: 'partial' },
};
fs.writeFileSync(path.join(missionRoot, sourceId + '.json'), JSON.stringify(source));

const originalStatus = policy.status;
const originalNextEligibleAt = policy.nextEligibleAt;
const originalCallTool = mcp.callTool;

const nextEligibleAt = new Date(Date.now() + 60_000).toISOString();
let liveCalls = 0;

policy.status = () => ({
  localBudgetBypass: false,
  manualLock: false,
  cooldownUntil: null,
  burstUsed: 0,
  burstMax: 10,
  hourlyUsed: 24,
  hourlyMax: 24,
  dailyUsed: 24,
  dailyMax: 75,
  missionToolMax: 12,
  testMissionToolMax: 120,
  deepProfilesPerMission: 8,
  maxJobPages: 3,
});
policy.nextEligibleAt = () => nextEligibleAt;
mcp.callTool = async () => {
  liveCalls++;
  throw new Error('Live LinkedIn MCP must not be called in a zero-budget cache-only verification test.');
};

const request = {
  entityMode: 'company',
  topic: 'SAP',
  count: 2,
  hiring: true,
  location: 'Maharashtra',
  locationScope: 'job',
  allowedLocations: ['Maharashtra', 'Bengaluru', 'Bangalore'],
  preferredLocations: ['Maharashtra', 'Bengaluru'],
  preferredWorkType: 'remote',
  filters: { employeeMax: 1000 },
  resumeExistingPool: true,
  reuseCachedEvidence: true,
  continueFromPrevious: false,
  allowPreviouslySeenCompanies: false,
  originalMessage: 'LinkedIn only. Reuse saved discovery and cached evidence first.',
};

async function waitFor(fn) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for cache-only mission.');
}

(async () => {
  let captured = null;
  runner.start(async (prepared) => {
    captured = await operator.companyMission(prepared.request);
    runner.persistResearch(captured);
    return {
      text: 'cache-only verified',
      linkedinMission: {
        found: captured.records.length,
        requested: prepared.request.count,
        added: 0,
        budgetStopped: captured.budgetStopped || null,
        safety: {},
      },
    };
  });

  const queued = runner.enqueue({ request });
  await waitFor(() => ['completed', 'partial', 'failed', 'waiting_safety'].includes(runner.get(queued.id).status));

  const finished = runner.get(queued.id);

  policy.status = originalStatus;
  policy.nextEligibleAt = originalNextEligibleAt;
  mcp.callTool = originalCallTool;

  assert.notEqual(finished.status, 'failed', JSON.stringify({
    error: finished.error || null,
    progress: finished.progress || null,
    stopCode: finished.stopCode || null,
    captured: captured ? {
      records: captured.records?.length || 0,
      budgetStopped: captured.budgetStopped || null,
      toolCalls: captured.toolCalls || null,
    } : null,
  }));
  assert.equal(finished.status, 'partial');
  assert(captured, 'Research result was not captured.');
  assert.equal(captured.records.length, 1);
  assert.ok(captured.budgetStopped, 'Partial cache-only verification should preserve verified rows and mark the remaining live work as safety-limited.');
  assert.equal(captured.records[0].company, 'Acme Software');
  assert.equal(captured.records[0].jobUrl, 'https://www.linkedin.com/jobs/view/90000001');
  assert.equal(captured.toolCalls.cachedJobDetailHits, 1);
  assert.equal(captured.toolCalls.cachedCompanyProfileHits, 1);
  assert.equal(liveCalls, 0);

  console.log('Cache-only SAP verification passed: cached evidence produced a verified company with zero live calls, returned it for writing, and left only the remaining target safety-limited.');
})().catch((error) => {
  policy.status = originalStatus;
  policy.nextEligibleAt = originalNextEligibleAt;
  mcp.callTool = originalCallTool;
  console.error(error);
  process.exitCode = 1;
});
