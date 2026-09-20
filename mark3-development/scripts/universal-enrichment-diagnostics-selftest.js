'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const diagnostics = require('../core/universal-enrichment-diagnostics');
const typedErrors = require('../core/spreadsheet-enrichment-errors');
const targeted = require('../core/universal-sheet-enrichment-targeted');
const fallbackPass = require('../core/universal-big-pickle-fallback-pass');

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

const requestedPoc3 = diagnostics.issueFromReason('requested-poc3-unresolved', {
  rowNumber: 8,
  groupOrdinal: 3,
});
assert.equal(requestedPoc3.code, 'POC3_REQUESTED_UNRESOLVED');
assert.equal(requestedPoc3.severity, 'WARNING');
assert.equal(requestedPoc3.blocking, false);
assert.equal(requestedPoc3.retryable, true);
assert.match(requestedPoc3.nextAction, /deep deterministic discovery and bounded AI rescue/i);
assert.ok(runtime.every((item) => item.blocking === false), 'pending contact work and optional POC-3 must not masquerade as mandatory failure');

const globalPending = diagnostics.formatIssue(diagnostics.issueFromReason('phone-callback-pending'));
assert.doesNotMatch(globalPending, /\[ROW 0\]/, 'global diagnostics must never coerce null row scope into row 0');

const capError = new Error('LinkedIn daily safety cap reached (100/100). Resume tomorrow rather than pushing the account harder.');
capError.code = 'LINKEDIN_DAILY_CAP';
capError.subsystem = 'LINKEDIN';
const typedCap = typedErrors.normalize(capError, { stage: 'candidate-discovery' });
assert.equal(typedCap.code, 'LINKEDIN_DAILY_CAP');
assert.equal(typedCap.subsystem, 'LINKEDIN');
assert.equal(typedCap.type, 'RATE_LIMIT');
assert.equal(typedCap.humanTitle, 'LinkedIn daily safety limit reached');
assert.match(typedCap.hint, /LinkedIn/i);
assert.match(typedCap.hint, /daily/i);
assert.match(typedCap.hint, /(reset|wait)/i);
assert.match(typedCap.hint, /(do not bypass|account-safety)/i);

const hourlyCapError = new Error('LinkedIn hourly safety cap reached.');
hourlyCapError.code = 'LINKEDIN_HOURLY_CAP';
hourlyCapError.subsystem = 'LINKEDIN';
const typedHourlyCap = typedErrors.normalize(hourlyCapError, { stage: 'candidate-discovery' });
assert.equal(typedHourlyCap.code, 'LINKEDIN_HOURLY_CAP');
assert.equal(typedHourlyCap.subsystem, 'LINKEDIN');
assert.equal(typedHourlyCap.type, 'RATE_LIMIT');
assert.equal(typedHourlyCap.humanTitle, 'LinkedIn hourly safety limit reached');
assert.match(typedHourlyCap.hint, /LinkedIn/i);
assert.match(typedHourlyCap.hint, /hourly/i);
assert.match(typedHourlyCap.hint, /(reset|wait)/i);
assert.match(typedHourlyCap.hint, /(do not bypass|account-safety)/i);

const fallbackStatsShape = fallbackPass.freshStats();
assert.ok(Array.isArray(fallbackStatsShape.discoveryDiagnostics), 'Big Pickle stats must initialize discoveryDiagnostics before base discovery helpers push into it');
assert.ok(Array.isArray(fallbackStatsShape.rankingThresholds), 'Big Pickle stats must inherit base ranking arrays');
assert.ok(Array.isArray(fallbackStatsShape.selectionAudit), 'Big Pickle stats must inherit base selection audit');

const recursionError = new RangeError('Maximum call stack size exceeded');
const typedRecursion = typedErrors.normalize(recursionError, { stage: 'candidate-discovery' });
assert.equal(typedRecursion.type, 'RECURSION');
assert.equal(typedRecursion.code, 'UNIVERSAL_RECURSION_STACK_OVERFLOW');
assert.match(typedRecursion.hint, /recursive wrapper\/helper loop/i);

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

const collapsedBlockers = targeted.collapseDiagnosticBlockers([
  {
    code: 'POC2_NO_DISCOVERY_CANDIDATES',
    severity: 'BLOCKER',
    blocking: true,
    retryable: true,
    rowNumber: 5,
    target: 'POC-2',
    message: 'Lifecycle wrapper',
  },
  {
    code: 'UNIVERSAL_RECURSION_STACK_OVERFLOW',
    severity: 'BLOCKER',
    blocking: true,
    retryable: true,
    rowNumber: 5,
    target: 'POC-2',
    message: 'Maximum call stack size exceeded',
    detail: 'candidate-discovery',
  },
  {
    code: 'UNIVERSAL_RECURSION_STACK_OVERFLOW',
    severity: 'BLOCKER',
    blocking: true,
    retryable: true,
    rowNumber: 5,
    target: 'POC-2',
    message: 'Maximum call stack size exceeded',
    detail: 'fallback-row-enrichment',
  },
]);
assert.equal(collapsedBlockers.length, 1, 'one typed root cause must supersede duplicate lifecycle wrappers for the same row/target');
assert.equal(collapsedBlockers[0].code, 'UNIVERSAL_RECURSION_STACK_OVERFLOW');

const rendered = diagnostics.formatIssue(exhausted);
assert.match(rendered, /^\[BLOCKER\]\[ROW 5\]\[POC-2\] No verified same-company POC-2 could be found\./);
assert.doesNotMatch(rendered, /POC2_NO_VERIFIED_CANDIDATE_AFTER_ALL_STRATEGIES/);

const root = path.join(__dirname, '..', 'core');
const operatorSource = fs.readFileSync(path.join(root, 'universal-sheet-enrichment-operator.js'), 'utf8');
const targetedSource = fs.readFileSync(path.join(root, 'universal-sheet-enrichment-targeted.js'), 'utf8');

assert.match(operatorSource, /deterministicRecheckRemainingMandatoryRows/);
assert.match(operatorSource, /deterministicRecheckRemainingRepairRows/);
assert.match(operatorSource, /Diagnostics:/);
assert.match(operatorSource, /company URNs/);
assert.match(operatorSource, /const pushLinkedInDiagnostic = \(payload = \{\}\) => \{[\s\S]*?stats\.discoveryDiagnostics\.push\(/);
assert.doesNotMatch(operatorSource, /const pushLinkedInDiagnostic = \(payload = \{\}\) => \{\s*pushLinkedInDiagnostic\(/);
assert.match(targetedSource, /MANDATORY_DATA_EXHAUSTED/);
assert.match(targetedSource, /FINAL_AUDIT_FAILED/);
assert.match(targetedSource, /AI_SKIPPED_NO_VERIFIED_CANDIDATE_POOL|ai-skipped-no-verified-candidate-pool/);
assert.match(targetedSource, /DIAGNOSTIC SUMMARY/);
assert.match(targetedSource, /Main problem:/);
assert.match(targetedSource, /Required blockers:/);
assert.match(targetedSource, /Repair or pending:/);
assert.doesNotMatch(targetedSource, /ROOT_CAUSE:/);
assert.doesNotMatch(targetedSource, /MANDATORY_BLOCKERS:/);
assert.match(targetedSource, /providerRetryReasonsFromPrimary/);
assert.match(targetedSource, /provider-retry-required/);
assert.match(targetedSource, /const gateBlockers/);
assert.match(targetedSource, /collapseDiagnosticBlockers/);
assert.match(targetedSource, /Problems:/);

console.log('Universal enrichment diagnostics self-test passed: machine codes remain available internally, visible row diagnostics and final root-cause summaries are plain English, LinkedIn daily/hourly safety caps are validated by stable condition plus plain-English meaning instead of brittle prose, requested POC-3 residue stays retryable, and mandatory blockers remain separate from repair/pending/optional work.');
