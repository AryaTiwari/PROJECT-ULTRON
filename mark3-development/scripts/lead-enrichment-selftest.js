#!/usr/bin/env node
const assert = require('assert');
const sheets = require('../core/google-sheets-operator');
const apollo = require('../core/apollo-enrichment');
const bootstrap = require('../core/lead-enrichment-bootstrap');

const rows = [
  ['Office lead list', '', '', '', ''],
  ['', '', '', '', ''],
  ['Name', 'Company', 'LinkedIn Profile URL', 'Email Address', 'Mobile Number'],
  ['A', 'Acme', 'https://www.linkedin.com/in/person-one?trk=test', '', ''],
  ['B', 'Beta', 'linkedin.com/in/person-two/', '', ''],
];

const layout = sheets.detectLayout(rows);
assert.equal(layout.headerRowNumber, 3);
assert.equal(layout.linkedinColumn, 'C');
assert.equal(layout.emailColumn, 'D');
assert.equal(layout.phoneColumn, 'E');
assert.equal(sheets.columnName(0), 'A');
assert.equal(sheets.columnName(25), 'Z');
assert.equal(sheets.columnName(26), 'AA');
assert.equal(apollo.normalizeLinkedIn('https://www.linkedin.com/in/person-one/?trk=abc'), 'https://www.linkedin.com/in/person-one');
assert.equal(apollo.normalizeLinkedIn('linkedin.com/in/person-two/'), 'https://www.linkedin.com/in/person-two');
assert.equal(apollo.normalizeLinkedIn('https://www.linkedin.com/company/acme'), null);
assert.ok(bootstrap.isEnrichmentRequest('Ultron, enrich this sheet with Apollo: https://docs.google.com/spreadsheets/d/abc123/edit#gid=0'));
assert.ok(bootstrap.isStatusRequest('Apollo enrichment status'));
assert.ok(bootstrap.isResumeRequest('resume Apollo enrichment'));

const inferred = sheets.detectLayout([
  ['Lead', 'Email', 'Phone', 'Profile'],
  ['1', '', '', 'https://www.linkedin.com/in/alpha'],
  ['2', '', '', 'https://www.linkedin.com/in/beta'],
]);
assert.equal(inferred.headerRowNumber, 1);
assert.equal(inferred.linkedinColumn, 'D');
assert.equal(inferred.emailColumn, 'B');
assert.equal(inferred.phoneColumn, 'C');

console.log('Lead enrichment self-test passed. Dynamic headers/columns, LinkedIn normalization and natural commands are healthy.');
