'use strict';

const assert = require('assert/strict');
const operator = require('../core/linkedin-account-operator');
const master = require('../core/linkedin-final-master');
const runner = require('../core/linkedin-mission-runner');

assert.equal(operator.explicitDeletionIntent('dedupe this LinkedIn sheet'), false);
assert.equal(operator.explicitDeletionIntent('clean duplicates in this LinkedIn sheet'), false);
assert.equal(operator.explicitDeletionIntent('remove duplicates from this LinkedIn sheet'), true);
assert.equal(operator.explicitDeletionIntent('delete duplicate rows from this spreadsheet'), true);
assert.equal(operator.explicitDeletionIntent('continue the LinkedIn mission'), false);

const repairSource = operator.repairFinalMasterSheetSchema.toString();
assert.equal(repairSource.includes('deleteDimension'), false, 'Automatic Final Master repair must not delete rows or columns.');

const reconcileSource = operator.reconcileFinalMasterRegistry.toString();
assert.equal(reconcileSource.includes('deleteDimension'), false, 'Final Master reconciliation must never delete rows.');

const buildSource = operator.buildFinalMaster.toString();
assert.equal(buildSource.includes('replaceMasterRecords'), false, 'Historical Final Master building must be additive.');

const dedupeSource = operator.dedupeWorkspaceSheet.toString();
assert.equal(dedupeSource.includes('deletionApproved'), true, 'Dedupe deletion must be guarded by explicit deletion intent.');
assert.equal(dedupeSource.includes('explicitDeletionIntent(text)'), true);

const replaceSource = master.replaceMasterRecords.toString();
assert.equal(replaceSource.includes('allowDestructiveReplace !== true'), true, 'Registry replacement must be non-destructive by default.');

assert.equal(
  operator.applicantCountFromDetail({ applicant_count: '37 applicants' }, 'Example Co'),
  '37',
);
assert.equal(
  operator.applicantCountFromText('SAP Consultant · India · Over 100 people clicked apply', 'Missing Company Label'),
  '100',
);

const indiaMeta = {
  title: 'SAP ABAP Consultant',
  bestKeyword: 'SAP ABAP',
  trustedLocations: ['Hyderabad'],
  trustedWorkTypes: ['remote'],
  hits: 3,
  firstRank: 1,
};
const neutralMeta = { ...indiaMeta, trustedLocations: [], trustedWorkTypes: [] };
assert.ok(
  operator.jobIdPriority(indiaMeta, { allowedLocations: ['India'], preferredWorkType: 'remote', filters: {} })
  > operator.jobIdPriority(neutralMeta, { allowedLocations: ['India'], preferredWorkType: 'remote', filters: {} }),
  'India-wide missions should prioritize trusted Indian location/work-type evidence.',
);

const mhMeta = { ...indiaMeta, trustedLocations: ['Pune'] };
assert.ok(
  operator.jobIdPriority(mhMeta, { allowedLocations: ['Maharashtra'], preferredLocations: ['Maharashtra'], filters: {} })
  > operator.jobIdPriority(indiaMeta, { allowedLocations: ['Maharashtra'], preferredLocations: ['Maharashtra'], filters: {} }),
  'Location priority must follow the current mission instead of a hard-coded region.',
);

const previous = {
  entityMode: 'company',
  topic: 'SAP',
  hiring: true,
  allowedLocations: ['Maharashtra', 'Bengaluru'],
  preferredLocations: ['Maharashtra', 'Bengaluru'],
  filters: { employeeMax: 1000 },
  savedDiscoveryOnly: true,
};
const continued = runner.compileResumeRequest(
  'Continue recovery mission 4769b9e3-4ae5-441f-b4da-cb8ce77d54a6. Hard requirements: India, maximum 1000 employees. Do not perform new search_jobs discovery unless the existing saved pool is exhausted.',
  previous,
);
assert.deepEqual(continued.allowedLocations, ['India']);
assert.equal(continued.location, 'India');
assert.equal(continued.savedDiscoveryOnly, false, 'Explicit after-exhaustion continuation must allow later fresh discovery.');

const cacheOnly = runner.compileResumeRequest(
  'Resume LinkedIn mission from saved evidence. Do not make fresh discovery in this recovery pass.',
  previous,
);
assert.equal(cacheOnly.savedDiscoveryOnly, true);

console.log('LinkedIn lead-scraper safety self-test passed: cache-first discovery, India override, applicant extraction, mission-aware ranking, and explicit-only deletion are enforced.');
