'use strict';

const assert = require('assert/strict');
const planner = require('../core/universal-enrichment-planner');

const person = {
  name: 'Pankaj Pandey',
  title: 'Manager HR / Talent Acquisition',
  linkedinUrl: 'https://www.linkedin.com/in/pankaj-pandey-example/',
  phone: '+919999999999',
  email: 'pankaj@example.com',
  organizationName: 'Example Technologies',
};

// Contact-style schema with no dedicated role column: preserve the verified
// designation in the identity cell instead of silently discarding it.
{
  const group = {
    id: 'person-2-7',
    kind: 'person',
    ordinal: 2,
    fields: {
      name: { index: 7, header: '2nd POC Name', role: 'name' },
      phone: { index: 8, header: 'Phone no', role: 'phone' },
      email: { index: 9, header: 'Email ID', role: 'email' },
    },
  };
  const row = Array(10).fill('');
  const result = planner.safeWritesForGroup(row, group, person);
  const nameWrite = result.writes.find((write) => write.field === 'name');
  assert.equal(result.allowed, true);
  assert.ok(nameWrite);
  assert.equal(nameWrite.value, 'Pankaj Pandey — Manager HR / Talent Acquisition');
  assert.equal(nameWrite.embeddedRole, true);
}

// Same-person repair: a previously written bare name can be upgraded safely.
{
  const group = {
    id: 'person-2-7',
    kind: 'person',
    ordinal: 2,
    fields: {
      name: { index: 7, header: '2nd POC Name', role: 'name' },
      phone: { index: 8, header: 'Phone no', role: 'phone' },
      email: { index: 9, header: 'Email ID', role: 'email' },
    },
  };
  const row = Array(10).fill('');
  row[7] = 'Pankaj Pandey';
  const result = planner.safeWritesForGroup(row, group, person);
  const nameWrite = result.writes.find((write) => write.field === 'name');
  assert.ok(nameWrite, 'same-person bare name should receive verified designation');
  assert.equal(nameWrite.value, 'Pankaj Pandey — Manager HR / Talent Acquisition');
  assert.equal(nameWrite.replaces, 'Pankaj Pandey');
}

// A schema with a dedicated role column must keep identity and designation
// separate instead of decorating the name cell.
{
  const group = {
    id: 'person-1-0',
    kind: 'person',
    ordinal: 1,
    fields: {
      name: { index: 0, header: 'Decision Maker Name', role: 'name' },
      role: { index: 1, header: 'Designation', role: 'role' },
      email: { index: 2, header: 'Business Email', role: 'email' },
    },
  };
  const row = ['', '', ''];
  const result = planner.safeWritesForGroup(row, group, person);
  assert.equal(result.writes.find((write) => write.field === 'name')?.value, 'Pankaj Pandey');
  assert.equal(result.writes.find((write) => write.field === 'role')?.value, 'Manager HR / Talent Acquisition');
}

console.log('Universal contact display self-test passed: schemas without a role column embed verified designation in the contact name, same-person bare names can be upgraded, and dedicated role columns stay separate.');
