'use strict';

const assert = require('assert/strict');

require('../core/universal-deterministic-bootstrap').install();

const schemaTools = require('../core/universal-sheet-schema');
const controller = require('../core/universal-spreadsheet-domain-controller');
const operator = require('../core/universal-sheet-enrichment-operator');
const sheets = require('../core/google-sheets-operator');

function brokenArya2Rows() {
  return [
    ['Person or Company Name','L','Post Details','L','Linkedin Id','Phone no','Email ID'],
    ['Apoorva Wanegaon','L','Hiring SAP consultant',null,'https://www.linkedin.com/in/apoorva-wanegaon-09a424261/','','apoorva.r@sunrisebiztechsys.com'],
    ['Akash Kandharkar','L','Hiring SAP BTP consultant',null,'https://www.linkedin.com/in/akash-kandharkar-07641a1a0/','+918421207804','akash@sudhakamalitsolutions.com'],
  ];
}

const prompt = [
  'Target only the `Arya 2` worksheet.',
  'Maintain exactly 3 person/contact groups: POC-1, POC-2 and POC-3.',
].join('\n');

assert.equal(controller.parseExpectedPersonGroups(prompt), 3);
assert.equal(controller.parseExpectedPersonGroups('Use 3 POCs for this run.'), 3);
assert.equal(controller.parseExpectedPersonGroups('POC-2 and POC-3 must be filled.'), 3);
assert.equal(controller.parseExpectedPersonGroups('Run generic enrichment only.'), 0);

const rows = brokenArya2Rows();
const schema = schemaTools.inferSchema(rows, { expectedPersonGroups: 3 });

assert.equal(schema.personGroups.length, 3, 'missing trailing POC groups must be recovered only when explicitly expected');
assert.equal(schema.expectedPersonGroups, 3);
assert.equal(schema.continuityRecoveries.length, 2);
assert.equal(schema.headerRepairs.length, 6);

const p1 = schema.personGroups.find((group) => group.ordinal === 1);
const p2 = schema.personGroups.find((group) => group.ordinal === 2);
const p3 = schema.personGroups.find((group) => group.ordinal === 3);

assert.ok(p1?.fields?.name, 'POC-1 must remain the existing anchor group');
assert.deepEqual(
  { name: p2.fields.name.index, phone: p2.fields.phone.index, email: p2.fields.email.index },
  { name: 7, phone: 8, email: 9 },
  'POC-2 continuity must recover H:J'
);
assert.deepEqual(
  { name: p3.fields.name.index, phone: p3.fields.phone.index, email: p3.fields.email.index },
  { name: 10, phone: 11, email: 12 },
  'POC-3 continuity must recover K:M'
);

assert.deepEqual(
  schema.headerRepairs.map((item) => item.value),
  ['2nd POC Name','Phone no','Email ID','3rd POC','Phone no','Email ID']
);

const noExpectation = schemaTools.inferSchema(brokenArya2Rows(), {});
assert.equal(noExpectation.personGroups.length, 1, 'continuity recovery must not globally invent extra POC groups');

async function run() {
  const source = {
    spreadsheetId: 'sheet-test',
    sheetName: 'Arya 2',
    rows: brokenArya2Rows(),
    schema,
  };
  const stats = operator.freshStats();
  const originals = {
    readCell: sheets.readCell,
    writeCells: sheets.writeCells,
  };
  const writes = [];
  try {
    sheets.readCell = async (_id, range) => range.endsWith('I1') ? 'Existing protected header' : '';
    sheets.writeCells = async (_id, changes) => {
      writes.push(...changes);
      return { updatedCells: changes.length };
    };

    await operator.applyRecoveredHeaderRepairs(source, stats);

    assert.equal(stats.headerRepairsPlanned, 6);
    assert.equal(stats.headerRepairsWritten, 5);
    assert.equal(stats.headerRepairsSkippedPopulated, 1);
    assert.equal(writes.some((item) => item.range === "'Arya 2'!H1" && item.value === '2nd POC Name'), true);
    assert.equal(writes.some((item) => item.range === "'Arya 2'!I1"), false, 'populated header cell must never be overwritten');
    assert.equal(writes.some((item) => item.range === "'Arya 2'!K1" && item.value === '3rd POC'), true);
    assert.equal(writes.some((item) => item.range === "'Arya 2'!M1" && item.value === 'Email ID'), true);
  } finally {
    sheets.readCell = originals.readCell;
    sheets.writeCells = originals.writeCells;
  }

  console.log('Universal schema continuity self-test passed: explicit 3-POC intent recovers missing H:M contact groups from blank trailing space, restores only blank headers after approval, preserves populated header cells, and generic sheets do not receive invented groups.');
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { run };
