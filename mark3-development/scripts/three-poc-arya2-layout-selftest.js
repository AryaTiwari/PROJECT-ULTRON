'use strict';

const assert = require('assert/strict');
const threePoc = require('../core/three-poc-enrichment-operator');

// Exact current Arya 2 header shape from the live Google Sheet. Keep this test
// intentionally literal: if the legacy detector rejects this, the compatibility
// workflow itself is broken. Runtime THREE_POC_LAYOUT_NOT_FOUND with this test
// passing means the runtime did not receive this worksheet/value shape.
const rows = [[
  'Person or Company Name',
  'L',
  'Post Details',
  'L',
  'Linkedin Id',
  'Phone no',
  'Email ID',
  '2nd POC Name',
  'Phone no',
  'Email ID',
  '3rd POC',
  'Phone no',
  'Email ID',
  'Call Outcome',
  'Remarks',
], [
  'Example Person',
  'L',
  'Hiring SAP consultant',
  '',
  'ID: https://www.linkedin.com/in/example-person/',
  '',
  'example@company.test',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
]];

const layout = threePoc.detectThreePocLayout(rows);
assert.equal(layout.schema, 'anchored_first_poc');
assert.equal(layout.headerRowNumber, 1);
assert.equal(layout.linkedinIndex, 4);
assert.deepEqual(
  {
    first: [layout.first.nameIndex, layout.first.phoneIndex, layout.first.emailIndex],
    second: [layout.second.nameIndex, layout.second.phoneIndex, layout.second.emailIndex],
    third: [layout.third.nameIndex, layout.third.phoneIndex, layout.third.emailIndex],
  },
  {
    first: [0, 5, 6],
    second: [7, 8, 9],
    third: [10, 11, 12],
  },
);

console.log('Arya 2 legacy layout self-test passed: the exact live header resolves as anchored_first_poc with POC-1 A/F/G, POC-2 H/I/J, POC-3 K/L/M and LinkedIn E.');
