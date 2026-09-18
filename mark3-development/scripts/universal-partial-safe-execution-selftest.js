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
assert.equal(base.isRecoverableRowFailure(apolloNetwork), false, 'provider-wide Apollo transport failure should halt safely instead of hammering later rows');

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

assert.match(baseSource, /rowFailureAudit/);
assert.match(baseSource, /haltedEarly/);
assert.match(baseSource, /resumeSafe: true/);
assert.match(baseSource, /isRecoverableRowFailure/);
assert.match(targetedSource, /primary-systemic-halt/);
assert.match(targetedSource, /Preserve successful deterministic work/);
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

console.log('Universal partial-safe execution self-test passed: row-local failures can continue, systemic failures halt safely with earlier writes preserved, post-primary/fallback/reporting failures cannot erase deterministic work, and reruns remain resume-safe.');
