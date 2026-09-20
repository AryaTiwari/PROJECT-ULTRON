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

// Auth failures are handled before grid/range recovery. A stale access token must
// be recognized as unauthorized so the Values wrapper can force-refresh exactly once.
assert.equal(hardening.isUnauthorized(Object.assign(new Error('Invalid Credentials'), { status: 401 })), true);
assert.equal(hardening.isUnauthorized({ googleStatus: 'UNAUTHENTICATED' }), true);
assert.equal(hardening.isUnauthorized(Object.assign(new Error('Bad request'), { status: 400 })), false);
const authError = hardening.authRequiredError(new Error('still unauthorized'));
assert.equal(authError.code, 'GOOGLE_SHEETS_AUTH_REQUIRED');
assert.equal(authError.status, 401);
assert.match(authError.reauthorizeCommand, /google-sheets-auth\.js/i);

async function run() {
  const parsed = hardening.parseSheetRange("'Arya 2'!A:ZZ");
  const physicalLastColumnIndex = 14; // O
  const fakeValues = async (_id, range) => {
    const col = String(range).match(/!([A-Z]+)1:/)?.[1];
    if (!col) return [];
    let index = 0;
    for (const char of col) index = index * 26 + (char.charCodeAt(0) - 64);
    index -= 1;
    if (index > physicalLastColumnIndex) {
      const error = new Error(`Range (${range}) exceeds grid limits. Max columns: 15`);
      error.status = 400;
      throw error;
    }
    return [];
  };

  const last = await hardening.lastReadableColumn(fakeValues, 'sheet-id', parsed);
  assert.equal(last, 14, 'Values-only binary probe must discover O as the last readable Arya 2 column without metadata');
  assert.equal(
    hardening.rangeWithEndColumn(parsed, last),
    "'Arya 2'!A:O",
    'metadata-free recovery must rebuild the final safe A:O range',
  );

  console.log('Google Sheets values hardening self-test passed: stale 401 tokens are recognized for forced-refresh recovery, while wide universal reads still recover from real grid failures with metadata or Values-only probing.');
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { run };
