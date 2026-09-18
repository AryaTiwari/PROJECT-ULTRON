'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

require('../core/universal-deterministic-bootstrap').install();
const operator = require('../core/universal-sheet-enrichment-operator');

const company = { company: 'Sunrise Systems, Inc', domain: 'sunrisesys.com' };
const existing = {
  group: {
    id: 'person_2',
    ordinal: 2,
    fields: {
      name: { index: 7, header: '2nd POC Name' },
      phone: { index: 8, header: 'Phone no' },
      email: { index: 9, header: 'Email ID' },
    },
  },
  snapshot: {
    values: {
      name: 'Hemanth Raj — Associate Team Lead - Talent Acquisition',
      phone: '',
      email: 'hemanth.r@sunrisesys.com',
      linkedin: '',
    },
    hasIdentity: true,
    linkedinKind: 'none',
  },
  isAnchor: false,
};

const candidates = [
  {
    id: 'apollo-hemanth',
    name: 'Hemanth Raj',
    title: 'Associate Team Lead - Talent Acquisition',
    organizationName: 'Sunrise Systems, Inc',
    organizationDomain: 'sunrisesys.com',
  },
  {
    id: 'apollo-other',
    name: 'Other Recruiter',
    title: 'Recruiter',
    organizationName: 'Sunrise Systems, Inc',
    organizationDomain: 'sunrisesys.com',
  },
];

const exact = operator.exactCandidateForExisting(existing, candidates, company);
assert.equal(exact?.id, 'apollo-hemanth', 'existing POC name should resolve to the unique same-employer discovery candidate');

const ambiguous = operator.exactCandidateForExisting(existing, [...candidates, { ...candidates[0], id: 'duplicate-hemanth' }], company);
assert.equal(ambiguous, null, 'duplicate exact-name candidates must not be guessed');

const wrongEmployer = operator.exactCandidateForExisting(existing, [{ ...candidates[0], organizationName: 'Other Corp', organizationDomain: 'other.example' }], company);
assert.equal(wrongEmployer, null, 'same-name candidate at a different employer must be rejected');

const queue = [];
operator.queuePendingPhone(
  { pendingPhoneQueue: queue },
  7,
  existing.group,
  existing.snapshot,
  { id: 'apollo-hemanth', name: 'Hemanth Raj', phoneStatus: 'pending', phone: '' },
);
assert.equal(queue.length, 1, 'verified Apollo person with pending phone must enter end-of-run phone sync');
assert.equal(queue[0].rowNumber, 7);
assert.equal(queue[0].columnIndex, 8);
assert.equal(queue[0].apolloPersonId, 'apollo-hemanth');

operator.queuePendingPhone(
  { pendingPhoneQueue: queue },
  7,
  existing.group,
  existing.snapshot,
  { id: 'apollo-hemanth', name: 'Hemanth Raj', phoneStatus: 'pending', phone: '' },
);
assert.equal(queue.length, 1, 'same person/cell phone request must not be queued twice');

const completedSnapshot = { ...existing.snapshot, values: { ...existing.snapshot.values, phone: '+919999999999' } };
operator.queuePendingPhone(
  { pendingPhoneQueue: queue },
  7,
  existing.group,
  completedSnapshot,
  { id: 'apollo-hemanth', name: 'Hemanth Raj', phoneStatus: 'pending', phone: '' },
);
assert.equal(queue.length, 1, 'already-populated phone cell must never be queued for overwrite');

const root = path.join(__dirname, '..', 'core');
const operatorSource = fs.readFileSync(path.join(root, 'universal-sheet-enrichment-operator.js'), 'utf8');
const bootstrapSource = fs.readFileSync(path.join(root, 'universal-deterministic-bootstrap.js'), 'utf8');
const fallbackSource = fs.readFileSync(path.join(root, 'universal-big-pickle-fallback.js'), 'utf8');

assert.match(operatorSource, /existingRepairNeedsDiscovery/);
assert.match(operatorSource, /candidatePool: people/);
assert.match(operatorSource, /same-company-discovery-exact-name/);
assert.match(operatorSource, /apollo\.fetchPhoneResults\(\)/);
assert.match(operatorSource, /apollo\.recordPhoneResult/);
assert.match(operatorSource, /sheets\.readCell/);
assert.match(operatorSource, /sheets\.isBlank/);
assert.match(operatorSource, /syncPendingPhoneAssignments\(source, pendingPhoneQueue/);
assert.match(operatorSource, /existingRepairAudit/);
assert.match(operatorSource, /phoneStillPending/);

assert.match(bootstrapSource, /apollo-three-poc-quality/);
assert.match(bootstrapSource, /three-poc-candidate-discovery-policy/);
assert.match(bootstrapSource, /const contactQuality = apolloQuality\.install\(\)/);
assert.match(bootstrapSource, /const highRecallDiscovery = candidateDiscovery\.install\(\)/);

assert.match(fallbackSource, /try \{\s*return await control\.runInternalInference\('spreadsheet-enrichment'/s);
assert.match(fallbackSource, /catch \(error\) \{\s*state\.failures\+\+;\s*state\.lastError/s);

async function run() {
  const apollo = require('../core/apollo-enrichment');
  const sheets = require('../core/google-sheets-operator');
  const originals = {
    fetchPhoneResults: apollo.fetchPhoneResults,
    recordPhoneResult: apollo.recordPhoneResult,
    consumePhoneResult: apollo.consumePhoneResult,
    readCell: sheets.readCell,
    writeCells: sheets.writeCells,
  };
  const writes = [];
  try {
    apollo.fetchPhoneResults = async () => [{ apollo_person_id: 'apollo-hemanth', phone: '+919876543210' }];
    apollo.recordPhoneResult = () => ['https://www.linkedin.com/in/hemanth-test'];
    apollo.consumePhoneResult = async () => true;
    sheets.readCell = async () => '';
    sheets.writeCells = async (_id, changes) => {
      writes.push(...changes);
      return { updatedCells: changes.length };
    };

    const stats = operator.freshStats();
    await operator.syncPendingPhoneAssignments(
      { spreadsheetId: 'sheet-test', sheetName: 'Arya 2' },
      queue,
      stats,
      { phoneSyncPolls: 1, phoneSyncWaitMs: 1 },
    );
    assert.equal(writes.length, 1, 'one verified pending phone should be written');
    assert.equal(writes[0].range, "'Arya 2'!I7");
    assert.equal(writes[0].value, '+919876543210');
    assert.equal(stats.phoneCellsFilled, 1);
    assert.equal(stats.phoneStillPending, 0);

    writes.length = 0;
    sheets.readCell = async () => '+911111111111';
    const populatedStats = operator.freshStats();
    await operator.syncPendingPhoneAssignments(
      { spreadsheetId: 'sheet-test', sheetName: 'Arya 2' },
      queue,
      populatedStats,
      { phoneSyncPolls: 1, phoneSyncWaitMs: 1 },
    );
    assert.equal(writes.length, 0, 'existing phone must never be overwritten by webhook completion');
    assert.equal(populatedStats.phoneWriteSkippedPopulated, 1);
  } finally {
    apollo.fetchPhoneResults = originals.fetchPhoneResults;
    apollo.recordPhoneResult = originals.recordPhoneResult;
    apollo.consumePhoneResult = originals.consumePhoneResult;
    sheets.readCell = originals.readCell;
    sheets.writeCells = originals.writeCells;
  }

  console.log('Universal contact completion self-test passed: existing POC names reuse unique same-employer Apollo discovery identities, verified pending phone callbacks write the exact blank POC phone cell without overwriting populated cells, universal verified-email/high-recall wrappers are installed, and Big Pickle control failures fail closed.');
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { run };
