const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ultron-linkedin-zero-budget-'));
const configPath = require.resolve('../core/config');
require.cache[configPath] = {
  id: configPath,
  filename: configPath,
  loaded: true,
  exports: { projectRoot, mark3Root: projectRoot },
};

const policy = require('../core/linkedin-account-policy');
const mcp = require('../core/linkedin-mcp-client');
const operator = require('../core/linkedin-account-operator');

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
  throw new Error('A live LinkedIn call must not run while the safety budget is zero.');
};

const request = {
  entityMode: 'company',
  topic: 'SAP',
  count: 21,
  hiring: true,
  location: 'Maharashtra',
  allowedLocations: ['Maharashtra', 'Bengaluru', 'Bangalore'],
  preferredLocations: ['Maharashtra', 'Bengaluru'],
  preferredWorkType: 'remote',
  filters: {
    employeeMax: 1000,
  },
  resumeExistingPool: true,
  continueFromPrevious: true,
  originalMessage: 'LinkedIn only: find enough new unique SAP companies to make the Final Master reach 30 total.',
};

(async () => {
  let caught = null;
  try {
    await operator.companyMission(request);
  } catch (error) {
    caught = error;
  } finally {
    policy.status = originalStatus;
    policy.nextEligibleAt = originalNextEligibleAt;
    mcp.callTool = originalCallTool;
  }

  assert(caught, 'Zero live budget with no reusable discovery must not return an empty successful research result.');
  assert.equal(caught.code, 'LINKEDIN_HOURLY_CAP');
  assert.equal(caught.cooldownUntil, nextEligibleAt);
  assert.equal(caught.linkedinSafetyGate, true);
  assert.equal(liveCalls, 0);

  console.log('Zero-budget LinkedIn regression passed: cache lookup may run first, but an unavailable live safety window parks the mission instead of completing with 0 leads.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
