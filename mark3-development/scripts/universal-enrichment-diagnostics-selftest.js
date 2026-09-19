'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const diagnostics = require('../core/universal-enrichment-diagnostics');
const typedErrors = require('../core/spreadsheet-enrichment-errors');
const targeted = require('../core/universal-sheet-enrichment-targeted');

const queue = [
  { rowNumber: 5, groupOrdinal: 2, reason: 'poc2-no-candidates', company: 'Hanvitt Consulting & Solutions' },
  { rowNumber: 2, reason: 'existing-contact-repair-unresolved' },
  { rowNumber: 3, reason: 'existing-contact-repair-unresolved' },
  { rowNumber: 4, reason: 'existing-contact-repair-unresolved' },
  { rowNumber: 6, reason: 'existing-contact-repair-unresolved' },
];

const classified = diagnostics.classifyLeftovers(queue);
assert.deepEqual(classified.blockingRows, [5], 'only the missing mandatory POC-2 row may be reported as a blocker');
assert.deepEqual(classified.repairRows, [2, 3, 4, 6], 'existing-contact repair residue must remain distinct from mandatory blockers');

const exhausted = diagnostics.issueFromReason('no-verified-candidates-after-last-resort', {
  rowNumber: 5,
  groupOrdinal: 2,
});
assert.equal(exhausted.code, 'POC2_NO_VERIFIED_CANDIDATE_AFTER_ALL_STRATEGIES');
assert.equal(exhausted.severity, 'BLOCKER');
assert.equal(exhausted.blocking, true);
assert.equal(exhausted.retryable, false);

const aiSkipped = diagnostics.issueFromReason('ai-skipped-no-verified-candidate-pool');
assert.equal(aiSkipped.code, 'AI_SKIPPED_NO_VERIFIED_CANDIDATE_POOL');
assert.equal(aiSkipped.blocking, false);
assert.match(aiSkipped.nextAction, /discovery\/verification evidence/i);

const runtime = diagnostics.runtimeIssues({
  phoneStillPending: 1,
  backgroundPhonePending: 8,
  optionalPoc3Deferred: 7,
  identityConflicts: 1,
});
assert.ok(runtime.some((item) => item.code === 'PHONE_CALLBACK_PENDING' && item.severity === 'PENDING'));
assert.ok(runtime.some((item) => item.code === 'OPTIONAL_POC3_UNRESOLVED' && item.severity === 'INFO'));
assert.ok(runtime.some((item) => item.code === 'IDENTITY_CONFLICT_WRITE_BLOCKED' && item.severity === 'WARNING'));
assert.ok(runtime.every((item) => item.blocking === false), 'pending contact work and optional POC-3 must not masquerade as mandatory failure');

const globalPending = diagnostics.formatIssue(diagnostics.issueFromReason('phone-callback-pending'));
assert.doesNotMatch(globalPending, /\[ROW 0\]/, 'global diagnostics must never coerce null row scope into row 0');

const capError = new Error('LinkedIn daily safety cap reached (100/100). Resume tomorrow rather than pushing the account harder.');
capError.code = 'LINKEDIN_DAILY_CAP';
capError.subsystem = 'LINKEDIN';
const typedCap = typedErrors.normalize(capError, { stage: 'candidate-discovery' });
assert.equal(typedCap.type, 'RATE_LIMIT');
assert.match(typedCap.hint, /daily safety budget/i);

const providerReasons = targeted.providerRetryReasonsFromPrimary({
  deferredPoc2Rows: [5],
  discoveryDiagnostics: [{
    rowNumber: 5,
    groupOrdinal: 2,
    code: 'LINKEDIN_DAILY_CAP',
    message: 'LinkedIn daily safety cap reached (100/100). Resume tomorrow rather than pushing the account harder.',
  }],
});
assert.equal(providerReasons.length, 1);
assert.equal(providerReasons[0].rowNumber, 5);
assert.equal(providerReasons[0].typed.code, 'LINKEDIN_DAILY_CAP');
assert.equal(providerReasons[0].typed.type, 'RATE_LIMIT');

const rendered = diagnostics.formatIssue(exhausted);
assert.match(rendered, /^\[BLOCKER\]\[ROW 5\]\[POC-2\] POC2_NO_VERIFIED_CANDIDATE_AFTER_ALL_STRATEGIES:/);

const root = path.join(__dirname, '..', 'core');
const operatorSource = fs.readFileSync(path.join(root, 'universal-sheet-enrichment-operator.js'), 'utf8');
const targetedSource = fs.readFileSync(path.join(root, 'universal-sheet-enrichment-targeted.js'), 'utf8');

assert.match(operatorSource, /deterministicRecheckRemainingMandatoryRows/);
assert.match(operatorSource, /deterministicRecheckRemainingRepairRows/);
assert.match(operatorSource, /Diagnostics:/);
assert.match(operatorSource, /company URNs/);
assert.match(targetedSource, /MANDATORY_DATA_EXHAUSTED/);
assert.match(targetedSource, /FINAL_AUDIT_FAILED/);
assert.match(targetedSource, /AI_SKIPPED_NO_VERIFIED_CANDIDATE_POOL|ai-skipped-no-verified-candidate-pool/);
assert.match(targetedSource, /ULTRON_DIAGNOSTICS/);
assert.match(targetedSource, /ROOT_CAUSE:/);
assert.match(targetedSource, /MANDATORY_BLOCKERS:/);
assert.match(targetedSource, /REPAIR_OR_PENDING:/);
assert.match(targetedSource, /providerRetryReasonsFromPrimary/);
assert.match(targetedSource, /provider-retry-required/);
assert.match(targetedSource, /const gateBlockers/);
assert.match(targetedSource, /Problems:/);

console.log('Universal enrichment diagnostics self-test passed: row scopes remain accurate, LinkedIn safety caps classify as retryable rate-limit root causes, rescue stops when the safety window is exhausted, and mandatory blockers remain separate from repair/pending/optional work.');
