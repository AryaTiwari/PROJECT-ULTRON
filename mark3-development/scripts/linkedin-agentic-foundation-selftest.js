#!/usr/bin/env node
const assert = require('assert');
const contract = require('../core/linkedin-mission-contract');
const strategist = require('../core/linkedin-query-strategist');
const operator = require('../core/linkedin-account-operator');

const legacy = {
  count: 25,
  entityMode: 'company',
  location: 'Maharashtra',
  hiring: true,
  topic: 'SAP',
  filters: { employeeMin: null, employeeMax: 1000, workType: 'remote', jobType: null, experienceLevel: null, datePosted: null, easyApply: false },
  useFinalMaster: true,
  allowPreviouslySeenCompanies: false,
};

const text = [
  'LinkedIn only: Find enough NEW unique companies with active SAP job openings to make my Final Master reach exactly 30 verified companies total.',
  'Locations: Maharashtra and Bengaluru/Bangalore.',
  'Prioritize Maharashtra first, then use Bengaluru to fill the remaining target.',
  'Remote roles preferred.',
  'Maximum 1000 employees.',
].join('\n');

const compiled = contract.compile(text, legacy, {
  knownLocations: ['Maharashtra','Pune','Mumbai','Bengaluru','Karnataka'],
});
assert.equal(compiled.target.mode, 'master_total');
assert.equal(compiled.target.value, 30);
assert.deepEqual(compiled.hard.locations, ['Maharashtra','Bengaluru']);
assert.equal(compiled.hard.employeeMax, 1000);
assert.equal(compiled.hard.workType, null);
assert.equal(compiled.preferences.workType, 'remote');
assert.equal(compiled.preferences.locations[0], 'Maharashtra');
assert.equal(compiled.dedupe.allowPreviouslySeen, false);
assert.equal(compiled.relaxation.hardConstraintsLocked, true);

const applied = contract.apply(compiled, legacy);
assert.deepEqual(applied.allowedLocations, ['Maharashtra','Bengaluru']);
assert.equal(applied.filters.workType, null);
assert.equal(applied.preferredWorkType, 'remote');
assert.equal(applied.targetMode, 'master_total');
assert.equal(applied.targetTotal, 30);
assert.equal(applied.useFinalMaster, true);

const resumed = contract.apply(
  contract.compile('Resume LinkedIn mission c27d9556-fe03-44f4-8a79-d3ba31e42516', applied, {
    knownLocations: ['Maharashtra','Bengaluru','Bangalore'],
  }),
  applied
);
assert.deepEqual(resumed.allowedLocations, ['Maharashtra','Bengaluru']);
assert.deepEqual(resumed.preferredLocations, ['Maharashtra','Bengaluru']);
assert.equal(resumed.preferredWorkType, 'remote');
assert.equal(resumed.filters.workType, null);
assert.equal(resumed.targetMode, 'master_total');
assert.equal(resumed.targetTotal, 30);

const strict = contract.compile('Find SAP companies in Pune, remote only, under 500 employees', {
  ...legacy,
  location: 'Pune',
  filters: { ...legacy.filters, employeeMax: 500 },
}, { knownLocations: ['Pune'] });
assert.equal(strict.hard.workType, 'remote');
assert.equal(strict.preferences.workType, null);
assert.equal(strict.hard.employeeMax, 500);

const addMore = contract.compile('add 10 more new companies', legacy, { knownLocations: [] });
assert.equal(addMore.target.mode, 'additional');
assert.equal(addMore.target.value, 10);

const plan = [
  { keyword: 'SAP', location: 'Maharashtra' },
  { keyword: 'SAP', location: 'Bengaluru' },
  { keyword: 'SAP FICO', location: 'Maharashtra' },
];
const first = strategist.selectNext(plan, { preferredLocations: ['Maharashtra','Bengaluru'], topic: 'SAP', history: [] });
assert.equal(first.location, 'Maharashtra');
assert.equal(first.keyword, 'SAP');
const second = strategist.selectNext(plan, {
  preferredLocations: ['Maharashtra','Bengaluru'],
  topic: 'SAP',
  history: [{ keyword: 'SAP', location: 'Maharashtra', uniqueJobIdsAdded: 0 }],
});
assert.equal(second.location, 'Bengaluru');
assert.equal(strategist.searchAllowance({ maximum: 12 }, 23), 2);
assert.equal(operator.isTransientMcpFailure(Object.assign(new Error('LinkedIn MCP request timed out after 180000ms.'), { code: 'LINKEDIN_MCP_TIMEOUT' })), true);
assert.equal(operator.isTransientMcpFailure(Object.assign(new Error('socket reset'), { code: 'ECONNRESET' })), true);
assert.equal(operator.isTransientMcpFailure(new Error('invalid credentials')), false);

const preferencePlan = [
  { keyword: 'SAP', location: 'India', workType: 'remote' },
  { keyword: 'SAP', location: 'India', workType: null },
  { keyword: 'SAP', location: 'Bengaluru', workType: 'remote' },
];
const relaxedPreference = strategist.selectNext(preferencePlan, {
  preferredLocations: ['India'],
  topic: 'SAP',
  history: [{ keyword: 'SAP', location: 'India', workType: 'remote', uniqueJobIdsAdded: 0 }],
});
assert.equal(relaxedPreference.location, 'India');
assert.equal(relaxedPreference.workType, null);

console.log('LinkedIn agentic foundation tests passed: mission contracts separate hard constraints/preferences, preserve multi-location intent, adaptive queries can relax weak preferences without changing hard constraints, and transient MCP failures are recoverable.');
