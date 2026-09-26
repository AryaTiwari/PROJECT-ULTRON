'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const targeted = require('../core/universal-sheet-enrichment-targeted');
const base = require('../core/universal-sheet-enrichment-operator');
const engine = require('../core/universal-enrichment-engine');
const sheets = require('../core/google-sheets-operator');

(async () => {
  const originals = {
    readUniversalSheet: base.readUniversalSheet,
    pendingPhoneRowsForSource: base.pendingPhoneRowsForSource,
    analyzeSheet: engine.analyzeSheet,
    clearRows: sheets.clearRows,
  };

  let clearRowsCalls = 0;
  try {
    base.readUniversalSheet = async () => ({
      spreadsheetId: 'sheet-test',
      sheetName: 'Arya-24 sept',
      rows: [],
      schema: {
        personGroups: [
          { ordinal: 1, fields: { phone: { index: 3 } } },
          { ordinal: 2, fields: { phone: { index: 6 } } },
        ],
        columns: [{ index: 0 }, { index: 1 }, { index: 2 }, { index: 3 }, { index: 4 }, { index: 5 }, { index: 6 }],
      },
    });
    base.pendingPhoneRowsForSource = () => new Set();
    engine.analyzeSheet = () => ({
      rowPlans: [
        {
          rowNumber: 2,
          row: ['Company With Indian POC', '', '', '+919876543210', '', '', ''],
          plan: { anchor: { type: 'company' } },
        },
        {
          rowNumber: 3,
          row: ['Company With Foreign POC', '', '', '+14155552671', '', '', ''],
          plan: { anchor: { type: 'company' } },
        },
        {
          rowNumber: 4,
          row: ['Company With No Phone', '', '', '', '', '', ''],
          plan: { anchor: { type: 'company' } },
        },
      ],
    });
    sheets.clearRows = async () => {
      clearRowsCalls += 1;
      throw new Error('Apollo enrichment must never clear company rows');
    };

    const gate = await targeted.enforceIndianPhoneCompanyGate(
      { sheetUrl: 'https://docs.google.com/spreadsheets/d/test/edit', sheetName: 'Arya-24 sept' },
      { requireIndianPhone: true, expectedPersonGroups: 2 },
      { stats: { rowFailureAudit: [] } },
    );

    assert.deepEqual(gate.acceptedRows, [2]);
    assert.deepEqual(gate.foreignFallbackRows, [3]);
    assert.deepEqual(gate.rejectedRows, []);
    assert.deepEqual(gate.unresolvedRows, [4]);
    assert.deepEqual(gate.contactUnresolvedRows, [4]);
    assert.deepEqual(gate.preservedCompanyRows, [3, 4]);
    assert.equal(gate.clearedRows, 0);
    assert.equal(gate.companyRowDeletionAllowed, false);
    assert.equal(gate.nonDestructive, true);
    assert.equal(clearRowsCalls, 0, 'Apollo enrichment must never call sheets.clearRows for contactability failures');

    const coreDir = path.join(__dirname, '..', 'core');
    const targetedSource = fs.readFileSync(path.join(coreDir, 'universal-sheet-enrichment-targeted.js'), 'utf8');
    const reportSource = fs.readFileSync(path.join(coreDir, 'universal-run-report.js'), 'utf8');
    const controllerSource = fs.readFileSync(path.join(coreDir, 'universal-spreadsheet-domain-controller.js'), 'utf8');

    assert.doesNotMatch(targetedSource, /sheets\.clearRows\s*\(/, 'universal enrichment must not contain a row-clearing call');
    assert.match(targetedSource, /companyRowDeletionAllowed:\s*false/);
    assert.match(targetedSource, /preservedCompanyRows/);
    assert.match(reportSource, /Company rows deleted:\s*0/);
    assert.doesNotMatch(reportSource, /rejected and .* cleared/);
    assert.match(controllerSource, /existing company row is always preserved/);

    console.log('Non-destructive enrichment self-test passed: +91, foreign-only and no-phone cases preserve all existing company rows, never call clearRows, and use verified foreign fallback when available, and report no-phone contacts as unresolved only.');
  } finally {
    base.readUniversalSheet = originals.readUniversalSheet;
    base.pendingPhoneRowsForSource = originals.pendingPhoneRowsForSource;
    engine.analyzeSheet = originals.analyzeSheet;
    sheets.clearRows = originals.clearRows;
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
