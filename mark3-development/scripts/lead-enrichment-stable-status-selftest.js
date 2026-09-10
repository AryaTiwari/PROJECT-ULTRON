#!/usr/bin/env node
const assert = require('assert');
const stable = require('../core/lead-enrichment-stable-status');

assert.equal(stable.isStatusLike('Ultron, enrichment status'), true);
assert.equal(stable.isStatusLike('sync phone results'), true);
assert.equal(stable.isStatusLike('resume Apollo enrichment'), false);

assert.equal(
  stable.coverageFingerprint({
    linkedinRows: 67,
    phone: { found: 24, noData: 31, blank: 12 },
    email: { found: 61, noData: 6, blank: 0 },
  }),
  '67|24|31|12|61|6|0'
);

assert.deepEqual(
  stable.combineSync(
    { received: 5, resolved: 5, pending: 7 },
    { received: 3, resolved: 3, pending: 4 }
  ),
  { received: 8, resolved: 8, pending: 4, error: null }
);

const summary = {
  provider: 'google',
  spreadsheetId: 'sheet-1',
  sheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
  sheetName: 'Sheet1',
};

assert.equal(stable.sameTarget({ provider: 'google', spreadsheetId: 'sheet-1', sheetName: 'Sheet1' }, summary), true);
assert.equal(stable.sameTarget({ provider: 'google', spreadsheetId: 'sheet-2', sheetName: 'Sheet1' }, summary), false);
assert.equal(stable.sameTarget({ provider: 'microsoft', spreadsheetId: 'sheet-1', sheetName: 'Sheet1' }, summary), false);

const pending = stable.pendingRowNumbers(summary, {
  jobs: [
    {
      provider: 'google', spreadsheetId: 'sheet-1', sheetName: 'Sheet1', rows: {
        16: { rowNumber: 16, phonePending: true },
        21: { rowNumber: 21, phonePending: false },
      },
    },
    {
      provider: 'google', spreadsheetId: 'sheet-2', sheetName: 'Sheet1', rows: {
        22: { rowNumber: 22, phonePending: true },
      },
    },
  ],
});
assert.equal(pending.has(16), true);
assert.equal(pending.has(21), false);
assert.equal(pending.has(22), false);

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
  },
  true
);
assert.match(text, /Background callback writes were still settling/);
assert.match(text, /4 rows remain blank/);
assert.match(text, /Divya Paulraj \(row 16\)/);
assert.match(text, /candidates for an approved retry/);

console.log('Stable Apollo status self-test passed. Two-pass settling, combined callback accounting and blank-row pending/untracked diagnosis are healthy.');
