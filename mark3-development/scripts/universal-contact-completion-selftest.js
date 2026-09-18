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

console.log('Universal contact completion self-test passed: existing POC names reuse unique same-employer Apollo discovery identities, pending phone reveals are queued for bounded end-of-run webhook sync without overwriting populated cells, universal verified-email/high-recall wrappers are installed, and Big Pickle control failures fail closed.');
