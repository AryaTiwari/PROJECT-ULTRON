#!/usr/bin/env node
const assert = require('assert');
const stable = require('../core/lead-enrichment-stable-status');
const progress = require('../core/lead-enrichment-progress');

assert.equal(stable.isStatusLike('Ultron, enrichment status'), true);
assert.equal(stable.isStatusLike('sync phone results'), true);
assert.equal(stable.isStatusLike('resume Apollo enrichment'), false);

assert.equal(
  stable.coverageFingerprint({
    linkedinRows: 67,
    phone: { found: 31, noData: 32, blank: 4 },
    email: { found: 61, noData: 6, blank: 0 },
  }),
  '67|31|32|4|61|6|0'
);

assert.deepEqual(
  stable.combineSync(
    { received: 5, resolved: 5, pending: 7 },
    { received: 3, resolved: 3, pending: 4 }
  ),
  { received: 8, resolved: 8, pending: 4, error: null }
);

assert.equal(progress.cellState('null'), 'no_data');
assert.equal(progress.cellState(''), 'blank');
assert.equal(progress.cellState('+919876543210'), 'found');

const summary = {
  provider: 'google',
  spreadsheetId: 'sheet-1',
  sheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
  sheetName: 'Sheet1',
};

assert.equal(stable.sameTarget({ provider: 'google', spreadsheetId: 'sheet-1', sheetName: 'Sheet1' }, summary), true);
assert.equal(stable.sameTarget({ provider: 'google', spreadsheetId: 'sheet-2', sheetName: 'Sheet1' }, summary), false);
assert.equal(stable.sameTarget({ provider: 'microsoft', spreadsheetId: 'sheet-1', sheetName: 'Sheet1' }, summary), false);

const pendingState = {
  jobs: [
    {
      provider: 'google', spreadsheetId: 'sheet-1', sheetName: 'Sheet1', rows: {
        16: { rowNumber: 16, phonePending: true, requestedAt: '2026-09-10T10:00:00.000Z' },
        21: { rowNumber: 21, phonePending: false },
        24: { rowNumber: 24, phonePending: true, requestedAt: '2026-09-10T10:01:00.000Z' },
      },
    },
    {
      provider: 'google', spreadsheetId: 'sheet-2', sheetName: 'Sheet1', rows: {
        22: { rowNumber: 22, phonePending: true },
      },
    },
  ],
};
const pending = stable.pendingRowNumbers(summary, pendingState);
assert.equal(pending.has(16), true);
assert.equal(pending.has(21), false);
assert.equal(pending.has(24), true);
assert.equal(pending.has(22), false);
assert.equal(stable.pendingRowsByNumber(summary, pendingState).get(16).phonePending, true);

const text = stable.appendDiagnosis(
  'Base status.',
  {
    total: 4,
    pending: [
      { name: 'Divya Paulraj', rowNumber: 16, pending: true },
      { name: 'Kalaiselvi R', rowNumber: 21, pending: true },
    ],
    untracked: [
      { name: 'kalpanaa a', rowNumber: 22, pending: false },
      { name: 'Kanaka Durga Dora Swami', rowNumber: 24, pending: false },
    ],
    terminalPendingFlags: [
      { name: 'Abinaya Jagdish', rowNumber: 3, cellState: 'no_data' },
    ],
  },
  true
);
assert.match(text, /Background callback writes were still settling/);
assert.match(text, /4 truly blank rows remain/);
assert.match(text, /Divya Paulraj \(row 16\)/);
assert.match(text, /candidates for an approved retry/);
assert.match(text, /terminal phone cells and are ignored for retry decisions/);
assert.match(text, /Abinaya Jagdish \(row 3\)/);

console.log('Stable Apollo status self-test passed. Literal null is excluded from blank diagnosis, terminal callback-state drift is surfaced, and only truly empty phone cells are considered for retry.');
