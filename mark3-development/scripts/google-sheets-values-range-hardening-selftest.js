'use strict';

const assert = require('assert/strict');
const hardening = require('../core/google-sheets-values-range-hardening');

assert.deepEqual(
  hardening.parseSheetRange("'Arya 2'!A:ZZ"),
  { sheetName: 'Arya 2', startColumn: 'A', startRow: null, endColumn: 'ZZ', endRow: null },
);

assert.equal(
  hardening.clampRange("'Arya 2'!A:ZZ", { columnCount: 15, rowCount: 1000 }),
  "'Arya 2'!A:O",
  'Arya 2 wide universal read must clamp to physical A:O grid',
);

assert.equal(
  hardening.clampRange("'Arya 2'!A1:ZZ2000", { columnCount: 15, rowCount: 1000 }),
  "'Arya 2'!A1:O1000",
  'explicit row and column bounds must both clamp safely',
);

assert.equal(
  hardening.clampRange("'Arya 2'!F:M", { columnCount: 15, rowCount: 1000 }),
  "'Arya 2'!F:M",
  'already-safe ranges must remain unchanged',
);

assert.equal(
  hardening.shouldRetry(Object.assign(new Error("Range ('Arya 2'!A:ZZ) exceeds grid limits. Max rows: 1000, max columns: 15"), { status: 400 })),
  true,
);
assert.equal(hardening.shouldRetry(Object.assign(new Error('Invalid credentials'), { status: 401 })), false);

console.log('Google Sheets values range hardening self-test passed: wide universal reads clamp to the exact physical grid only on range/grid failures, including Arya 2 A:ZZ -> A:O.');
