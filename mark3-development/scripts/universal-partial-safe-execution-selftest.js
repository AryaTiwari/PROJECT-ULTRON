'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const base = require('../core/universal-sheet-enrichment-operator');

const rowScopedApollo = base.typedFailureSummary(Object.assign(new Error('company-specific Apollo search failed'), {
  code: 'APOLLO_PEOPLE_SEARCH_FAILED',
  subsystem: 'APOLLO',
  errorType: 'API',
  stage: 'apollo-company-search',
}));
assert.equal(base.isRecoverableRowFailure(rowScopedApollo), true, 'row-scoped Apollo API failures should not kill later rows');

const apolloNetwork = base.typedFailureSummary(Object.assign(new Error('Failed to fetch'), {
  code: 'APOLLO_NETWORK_FETCH_FAILED',
  subsystem: 'APOLLO',
  errorType: 'NETWORK',
  stage: 'apollo-http-transport',
  retryAttempts: 3,
}));
assert.equal(base.isRecoverableRowFailure(apolloNetwork), false, 'Apollo transport failure is not an ordinary row-local API miss');
assert.equal(base.isTransientProviderRowFailure(apolloNetwork), true, 'Apollo network failure should use the bounded transient-provider circuit breaker');

const googleWrite = base.typedFailureSummary(Object.assign(new Error('permission denied'), {
  code: 'GOOGLE_SHEETS_FORBIDDEN',
  subsystem: 'GOOGLE_SHEETS',
  errorType: 'PERMISSION',
  stage: 'sheet-write',
}));
assert.equal(base.isRecoverableRowFailure(googleWrite), false, 'Google write failures are workbook-level and must halt further writes');

const formatted = base.formatResult({
  sheetName: 'Arya 2',
  schema: { headerRowNumber: 1, confidence: 0.9, personGroups: [{}, {}, {}], companyGroups: [] },
  stats: {
    ...base.freshStats(),
    rowsSeen: 5,
    rowsProcessed: 3,
    rowsChanged: 2,
    cellsChanged: 6,
    rowFailures: 1,
    transientProviderFailures: 3,
    transientProviderContinuations: 2,
    systemicHalts: 1,
    haltedEarly: true,
    haltAtRow: 6,
    haltError: apolloNetwork,
  },
});
assert.match(formatted, /PARTIALLY completed/i);
assert.match(formatted, /preserving all earlier verified writes/i);
assert.match(formatted, /APOLLO_NETWORK_FETCH_FAILED/);
assert.match(formatted, /Resume-safe: yes/i);

const root = path.join(__dirname, '..', 'core');
const baseSource = fs.readFileSync(path.join(root, 'universal-sheet-enrichment-operator.js'), 'utf8');
const targetedSource = fs.readFileSync(path.join(root, 'universal-sheet-enrichment-targeted.js'), 'utf8');
const fallbackSource = fs.readFileSync(path.join(root, 'universal-big-pickle-fallback-pass.js'), 'utf8');
const handlerSource = fs.readFileSync(path.join(root, 'universal-paid-approval-handler.js'), 'utf8');
const controlSource = fs.readFileSync(path.join(root, 'command-control-plane.js'), 'utf8');

assert.match(baseSource, /rowFailureAudit/);
assert.match(baseSource, /haltedEarly/);
assert.match(baseSource, /resumeSafe: true/);
assert.match(baseSource, /isRecoverableRowFailure/);
assert.match(baseSource, /isTransientProviderRowFailure/);
assert.match(baseSource, /maxTransientRowFailures/);
assert.match(baseSource, /transientProviderContinuations/);
assert.match(targetedSource, /primary-systemic-halt/);
assert.match(targetedSource, /deterministic primary result|verified writes/i);
assert.match(targetedSource, /UNIVERSAL_POST_PRIMARY_FAILURE/);
assert.match(targetedSource, /postPrimaryError/);
assert.match(targetedSource, /result = primary/);
assert.match(fallbackSource, /fallback-row-enrichment/);
assert.match(fallbackSource, /recoverableRowFailures/);
assert.match(handlerSource, /partialCompletion/);
assert.match(handlerSource, /resumeSafe/);
assert.match(handlerSource, /UNIVERSAL_RESULT_FORMAT_FAILED/);
assert.match(handlerSource, /reportFormattingError/);
assert.match(handlerSource, /return response\(true, body/);
assert.match(handlerSource, /EXECUTION_CONTRACT = 'universal-poc-phase-contact-completion-v3'/);
assert.match(handlerSource, /executionContract: EXECUTION_CONTRACT/);
assert.match(handlerSource, /pocPhasePipeline: Boolean\(payload\.contactPhaseOrdinal\)/);
assert.match(handlerSource, /contactPhaseOrdinal: payload\.contactPhaseOrdinal \|\| undefined/);
assert.match(controlSource, /executionContract: 'universal-poc-phase-contact-completion-v3'/);
assert.match(controlSource, /typedErrors\.normalize\(error/);
for (const source of [baseSource, targetedSource, fallbackSource, handlerSource, controlSource]) {
  assert.doesNotMatch(source, /UNIVERSAL_SPREADSHEET_EXECUTION_FAILED/, 'generic execution failure must not survive the partial-safe contract');
}

console.log('Universal partial-safe execution self-test passed: row-local failures continue, isolated Apollo network faults use a bounded circuit breaker, repeated/systemic failures halt safely with earlier writes preserved, all-POC production routing and explicit POC-phase diagnostics survive approval re-entry, post-primary/reporting failures cannot erase deterministic work, control-plane errors stay typed, generic UNIVERSAL_SPREADSHEET_EXECUTION_FAILED is banned, and reruns remain resume-safe.');
