#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const rowSelection = require('../core/universal-row-selection');
const missionStore = require('../core/universal-enrichment-mission-store');
const universal = require('../core/universal-sheet-enrichment-operator');
const approvalHandler = require('../core/universal-paid-approval-handler');

const rows = Array.from({ length: 3478 }, (_, index) => 170 + index);
const selection = rowSelection.fromRows(rows);

assert.equal(selection.ranges.length, 1, 'contiguous 3,478-row missions must compress to one range');
assert.deepEqual(selection.ranges[0], { start: 170, end: 3647 });
assert.equal(selection.count, 3478);
assert.equal(rowSelection.contains(selection, 170), true);
assert.equal(rowSelection.contains(selection, 3647), true);
assert.equal(rowSelection.contains(selection, 169), false);
assert.ok(Buffer.byteLength(JSON.stringify(selection)) < 300, 'large forward row selection must stay constant-size');

const rowCheckpoints = {};
for (const rowNumber of rows) {
  rowCheckpoints[String(rowNumber)] = {
    rowNumber,
    state: rowNumber % 7 ? 'COMPLETE' : 'RETRY_REQUIRED',
    processed: rowNumber % 7 !== 0,
    slots: {
      1: { state: 'COMPLETE', fields: { phone: { state: 'FOUND' }, email: { state: 'FOUND' } } },
      2: { state: rowNumber % 7 ? 'COMPLETE' : 'PARTIAL', fields: { phone: { state: 'UNSEARCHED' }, email: { state: 'FOUND' } } },
    },
  };
}

const giantMission = {
  missionId: 'enrich-large-regression',
  provider: 'apollo',
  spreadsheetId: 'sheet-1',
  spreadsheetTitle: 'New_Sheet_14-09-25',
  spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/example/edit',
  sheetName: 'Arya-24 sept',
  sheetId: 1229007269,
  schemaFingerprint: 'company name|company link|1st poc name|phone|email|2nd poc name|phone|email|outcome',
  requestedPOCs: [1, 2],
  requestedFields: ['phone', 'email'],
  status: 'RUNNING',
  completionState: 'RUNNING',
  totalEligibleRows: rows.length,
  rowsProcessed: 2800,
  rowsRemaining: 678,
  rowCheckpoints,
  provenance: rows.map((rowNumber) => ({ rowNumber, source: 'apollo', value: 'x'.repeat(40) })),
  request: {
    originalMessage: 'x'.repeat(10000),
    targetRows: rows,
  },
  startRow: 170,
  endRow: 3647,
  lastProcessedRow: 2969,
  nextRow: 2970,
  writeScope: {
    allowed: [
      { ordinal: 1, field: 'phone', columnIndex: 3 },
      { ordinal: 1, field: 'email', columnIndex: 4 },
      { ordinal: 2, field: 'phone', columnIndex: 6 },
      { ordinal: 2, field: 'email', columnIndex: 7 },
    ],
  },
  protectedColumns: [0, 1, 8],
  apolloUsageLedger: { discoveryCalls: 100, personHydrations: 80, phoneReveals: 20 },
  providerState: { apollo: { state: 'CLOSED' } },
};

const publicMission = missionStore.publicSummary(giantMission);
const missionBytes = Buffer.byteLength(JSON.stringify(publicMission));
assert.ok(missionBytes < 12000, `public mission summary unexpectedly large: ${missionBytes} bytes`);
assert.equal(Object.prototype.hasOwnProperty.call(publicMission, 'rowCheckpoints'), false);
assert.equal(Object.prototype.hasOwnProperty.call(publicMission, 'provenance'), false);
assert.equal(Object.prototype.hasOwnProperty.call(publicMission, 'request'), false);

const giantStats = {
  rowsSeen: rows.length,
  rowsProcessed: rows.length,
  rowsChanged: 2000,
  cellsChanged: 4100,
  anchorsResolved: 3000,
  existingGroupsRepaired: 900,
  newPeopleSelected: 1200,
  candidateSearches: 200,
  candidateCacheHits: 500,
  hydrationAttempts: 1800,
  phoneCellsFilled: 1200,
  phoneStillPending: 40,
  emailCellsFilled: 1400,
  emailStillPending: 30,
  primarySweepDeferredRows: rows,
  deterministicRecheckAttempted: true,
  deterministicRecheckRows: rows,
  deterministicRecheckRemainingMandatoryRows: rows,
  deterministicRecheckRemainingRepairRows: rows,
  deterministicRecheckRemainingWarningRows: rows,
  rowFailureAudit: rows.map((rowNumber) => ({ rowNumber, code: 'TEST' })),
};
const formatted = universal.formatResult({
  sheetName: 'Arya-24 sept',
  schema: { headerRowNumber: 1, confidence: 0.96, personGroups: [{}, {}], companyGroups: [{}] },
  stats: giantStats,
});
assert.ok(Buffer.byteLength(formatted) < 7000, 'human-facing large-run result must stay bounded');
assert.match(formatted, /\+3470 more/);
assert.doesNotMatch(formatted, /170, 171, 172[\s\S]*3647/, 'formatter must never dump the entire row list');

const publicResult = approvalHandler.publicEnrichmentResult({
  ok: true,
  sheetName: 'Arya-24 sept',
  schema: { headerRowNumber: 1, confidence: 0.96, personGroups: [{}, {}], companyGroups: [{}], fingerprint: 'test' },
  stats: giantStats,
});
const resultBytes = Buffer.byteLength(JSON.stringify(publicResult));
assert.ok(resultBytes < 12000, `public enrichment result unexpectedly large: ${resultBytes} bytes`);
assert.equal(publicResult.stats.deferredRows.count, 3478);
assert.equal(publicResult.stats.deferredRows.sample.length, 8);

const chatTransportSource = fs.readFileSync(path.join(__dirname, '..', 'interface', 'chat-transport.js'), 'utf8');
assert.match(chatTransportSource, /history:\s*\[\]/, 'protected enrichment transport must drop chat history');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
assert.match(serverSource, /compactProtectedEnrichmentResponse/);
assert.match(serverSource, /REQUEST_TOO_LARGE/);
assert.match(serverSource, /ULTRON_M3_ENRICHMENT_RESPONSE_MAX_BYTES/);

console.log(`Large enrichment payload regression passed: 3,478 forward rows compress to ${Buffer.byteLength(JSON.stringify(selection))} bytes; public mission ${missionBytes} bytes; public result ${resultBytes} bytes; report ${Buffer.byteLength(formatted)} bytes.`);
