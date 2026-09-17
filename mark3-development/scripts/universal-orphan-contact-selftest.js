'use strict';

const assert = require('assert/strict');
const policy = require('../core/universal-orphan-contact-policy');
const operator = require('../core/universal-sheet-enrichment-operator');
const planner = require('../core/universal-enrichment-planner');

assert.equal(policy.equivalentPhone('+91 98765 43210', '9876543210'), true);
assert.equal(policy.equivalentPhone('+91 98765 43210', '9123456789'), false);

const orphan = {
  isAnchor: false,
  group: {
    id: 'person-2-7',
    kind: 'person',
    ordinal: 2,
    fields: {
      name: { index: 7, header: '2nd POC Name', role: 'name' },
      phone: { index: 8, header: 'Phone no', role: 'phone' },
      email: { index: 9, header: 'Email ID', role: 'email' },
    },
  },
  snapshot: {
    hasIdentity: false,
    values: { name: '', phone: '+91 98765 43210', email: 'person@example.com' },
  },
};

assert.equal(policy.isOrphanContactTarget(orphan), true);
assert.deepEqual(
  policy.verify(orphan.snapshot, { phone: '9876543210', email: 'PERSON@example.com' }).mismatches,
  []
);
assert.equal(policy.verify(orphan.snapshot, { phone: '9876543210', email: 'PERSON@example.com' }).verified, true);
assert.equal(policy.verify(orphan.snapshot, { phone: '9876543210', email: 'wrong@example.com' }).verified, false);
assert.equal(policy.verify(orphan.snapshot, { phone: '', email: 'person@example.com' }).verified, false, 'all existing orphan contact signals must be proven');

const plan = {
  groups: {
    open: [{ isAnchor: false, group: { id: 'person-3-10', ordinal: 3 }, snapshot: { hasIdentity: false, values: {} } }],
    partial: [orphan],
  },
};
const targets = operator.candidateFillTargets(plan);
assert.deepEqual(targets.map((item) => item.group.id), ['person-2-7', 'person-3-10']);

const row = Array(10).fill('');
row[8] = '+91 98765 43210';
row[9] = 'person@example.com';
const hydrated = {
  name: 'Verified Person',
  title: 'Talent Acquisition Manager',
  phone: '9876543210',
  email: 'person@example.com',
};
const proof = policy.verify(orphan.snapshot, hydrated);
assert.equal(proof.verified, true);
const writePlan = planner.safeWritesForGroup(row, orphan.group, hydrated);
assert.equal(writePlan.allowed, true);
assert.equal(writePlan.writes.find((write) => write.field === 'name')?.value, 'Verified Person — Talent Acquisition Manager');
assert.equal(writePlan.writes.some((write) => write.field === 'phone'), false, 'matching orphan phone must be preserved, not rewritten');
assert.equal(writePlan.writes.some((write) => write.field === 'email'), false, 'matching orphan email must be preserved, not rewritten');

console.log('Universal orphan-contact self-test passed: identity-less partial blocks become fillable only when every existing contact value matches the hydrated person, with existing contacts preserved.');
