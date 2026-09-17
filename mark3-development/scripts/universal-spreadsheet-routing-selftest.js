'use strict';

const assert = require('assert/strict');
const control = require('../core/command-control-plane');

const url = 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890/edit';

const generic = control.claim(`Enrich missing decision maker contacts, phones and emails in this spreadsheet: ${url}`);
assert.equal(generic.exclusive, true);
assert.equal(generic.domain, 'spreadsheet-enrichment');
assert.equal(generic.controller, 'three-poc-domain-controller');
assert.equal(generic.generalModelAllowed, false);

const flexible = control.claim(`Research and fill missing people data in ${url}; analyze the columns and populate verified contacts.`);
assert.equal(flexible.domain, 'spreadsheet-enrichment');

const legacy = control.claim(`Run anchored 3-POC enrichment on ${url}. POC 1, POC 2 and POC 3 must be completed.`);
assert.equal(legacy.domain, 'three-poc-spreadsheet');
assert.equal(legacy.controller, 'three-poc-domain-controller');

const ordinaryEdit = control.claim(`Update cell A1 in ${url} to "September".`);
assert.notEqual(ordinaryEdit.domain, 'spreadsheet-enrichment');
assert.notEqual(ordinaryEdit.domain, 'three-poc-spreadsheet');

const calculation = control.claim(`Calculate the sum of column D in ${url}.`);
assert.notEqual(calculation.domain, 'spreadsheet-enrichment');

assert.equal(control.invariantCodeForDomain('spreadsheet-enrichment'), 'SPREADSHEET_ENRICHMENT_ROUTE_INVARIANT_VIOLATION');
assert.equal(control.isUniversalSpreadsheetEnrichmentRequest(`Fill missing contacts in ${url}`), true);
assert.equal(control.isUniversalSpreadsheetEnrichmentRequest(`Change formatting in ${url}`), false);

console.log('Universal spreadsheet routing self-test passed: generic contact enrichment has first-class exclusive ownership, legacy 3-POC remains compatible, and ordinary sheet edits are not hijacked.');
