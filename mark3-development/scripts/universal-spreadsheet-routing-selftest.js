'use strict';

const assert = require('assert/strict');
const control = require('../core/command-control-plane');
const targetResolver = require('../core/universal-sheet-target-resolver');
const spreadsheetController = require('../core/universal-spreadsheet-domain-controller');

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

// Natural-language tab targeting forms used by the chat UI.
assert.equal(spreadsheetController.parseSheetName('Target only the `Gaurav 2` tab.'), 'Gaurav 2');
assert.equal(spreadsheetController.parseSheetName('Target only the Gaurav 2 tab.'), 'Gaurav 2');
assert.equal(spreadsheetController.parseSheetName('Target tab: "Arya 2"'), 'Arya 2');

// A validation cap must never be silent. This protects against a forgotten
// ULTRON_M3_THREE_POC_ROW_LIMIT making a tiny validation pass look like a full run.
assert.match(spreadsheetController.rowLimitNotice(8), /VALIDATION MODE IS ACTIVE/i);
assert.match(spreadsheetController.rowLimitNotice(8), /first 8 non-empty data rows/i);
assert.match(spreadsheetController.rowLimitNotice(undefined), /FULL-SHEET MODE/i);

// Exact worksheet targeting regression.
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

// Direct URL conflict remains fail-closed.
assert.throws(
  () => targetResolver.resolveTabs(meta, aryaUrl, { sheetName: 'Divya' }),
  (error) => error && error.code === 'UNIVERSAL_SHEET_TARGET_CONFLICT'
);

// But a file/@mention-expanded URL can carry a stale view gid. An explicit tab
// name in the user's actual command wins in this mode.
const mentionOverride = targetResolver.resolveTabs(meta, aryaUrl, {
  sheetName: 'Gaurav 2',
  explicitNameAuthoritative: true,
});
assert.equal(mentionOverride.target.name, 'Gaurav 2');
assert.equal(mentionOverride.target.sheetId, 333);
assert.equal(mentionOverride.targetSource, 'explicit-name-over-mention-gid');
assert.equal(mentionOverride.ignoredViewGid, 222);

assert.throws(
  () => targetResolver.resolveTabs(meta, `${url}#gid=999`, {}),
  (error) => error && error.code === 'UNIVERSAL_SHEET_GID_NOT_FOUND'
);

const untargeted = targetResolver.resolveTabs(meta, url, {});
assert.equal(untargeted.targeted, false);
assert.equal(untargeted.targetSource, 'none');
assert.equal(untargeted.targets.length, 3);

console.log('Universal spreadsheet routing self-test passed: generic enrichment ownership, quoted tab parsing, direct URL conflict safety, explicit-tab-over-mention-gid targeting, and visible validation/full-sheet mode are protected.');
