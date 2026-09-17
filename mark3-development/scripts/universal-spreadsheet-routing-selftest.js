'use strict';

const assert = require('assert/strict');
const control = require('../core/command-control-plane');
const targetResolver = require('../core/universal-sheet-target-resolver');

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

// Exact worksheet targeting regression. A gid supplied in the URL is authoritative;
// the engine must not scan all tabs and substitute a higher-confidence worksheet.
const meta = {
  sheets: [
    { properties: { title: 'Divya', sheetId: 111, index: 0 } },
    { properties: { title: 'Arya 2', sheetId: 222, index: 1 } },
    { properties: { title: 'Gaurav 2', sheetId: 333, index: 2 } },
  ],
};

const aryaUrl = `${url}#gid=222`;
const gidOnly = targetResolver.resolveTabs(meta, aryaUrl, {});
assert.equal(gidOnly.targeted, true);
assert.equal(gidOnly.targetSource, 'gid');
assert.equal(gidOnly.target.name, 'Arya 2');
assert.deepEqual(gidOnly.targets.map((tab) => tab.name), ['Arya 2']);

const nameOnly = targetResolver.resolveTabs(meta, url, { sheetName: 'Arya 2' });
assert.equal(nameOnly.targeted, true);
assert.equal(nameOnly.targetSource, 'name');
assert.equal(nameOnly.target.sheetId, 222);

const matchingNameAndGid = targetResolver.resolveTabs(meta, aryaUrl, { sheetName: 'arya 2' });
assert.equal(matchingNameAndGid.targetSource, 'name+gid');
assert.equal(matchingNameAndGid.target.name, 'Arya 2');

assert.throws(
  () => targetResolver.resolveTabs(meta, aryaUrl, { sheetName: 'Divya' }),
  (error) => error && error.code === 'UNIVERSAL_SHEET_TARGET_CONFLICT'
);

assert.throws(
  () => targetResolver.resolveTabs(meta, `${url}#gid=999`, {}),
  (error) => error && error.code === 'UNIVERSAL_SHEET_GID_NOT_FOUND'
);

const untargeted = targetResolver.resolveTabs(meta, url, {});
assert.equal(untargeted.targeted, false);
assert.equal(untargeted.targetSource, 'none');
assert.equal(untargeted.targets.length, 3);

console.log('Universal spreadsheet routing self-test passed: generic contact enrichment has first-class exclusive ownership, legacy 3-POC remains compatible, ordinary sheet edits are not hijacked, and explicit worksheet name/gid targets cannot drift to another tab.');
