#!/usr/bin/env node
const assert = require('assert');
const repair = require('../core/lead-enrichment-null-phone-repair');

const fakeAdapter = {
  isBlank(value) {
    return value === '' || value === null || value === undefined;
  },
};

assert.equal(repair.isNullSentinel('null'), true);
assert.equal(repair.isNullSentinel(' NULL '), true);
assert.equal(repair.isNullSentinel('+919999999999'), false);
assert.equal(repair.phoneCellNeedsLocalRepair('null', fakeAdapter), true);
assert.equal(repair.phoneCellNeedsLocalRepair('', fakeAdapter), true);
assert.equal(repair.phoneCellNeedsLocalRepair('+919999999999', fakeAdapter), false);

const layout = { phoneColumnIndex: 5, linkedinColumnIndex: 4 };
assert.equal(
  repair.localPhoneCandidate([
    'Srushti More',
    'L',
    'Interested candidates can share CV / DM me on -9684020880',
    '',
    'ID: https://www.linkedin.com/in/srushti-more/',
    'null',
    'someone@example.com',
  ], layout),
  '+919684020880'
);

assert.equal(
  repair.localPhoneCandidate([
    'Ashish Sharma',
    'L',
    'Contact: #8448712209\nEmail: ashish@example.com',
    '',
    'ID: https://www.linkedin.com/in/ashish/',
    'null',
    'ashish@example.com',
  ], layout),
  '+918448712209'
);

assert.equal(
  repair.localPhoneCandidate([
    'No phone',
    'L',
    'Salary: 9876543210\nJob ID: 9123456789',
    '',
    'ID: https://www.linkedin.com/in/no-phone/',
    'null',
    'x@example.com',
  ], layout),
  null
);

console.log('Null-phone repair self-test passed. Stale null and blank phone cells can be replaced from trustworthy post-detail phone evidence without making Apollo calls.');
