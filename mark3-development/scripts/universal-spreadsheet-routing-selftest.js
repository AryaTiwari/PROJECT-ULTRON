'use strict';

const assert = require('assert/strict');
const control = require('../core/command-control-plane');
const targetResolver = require('../core/universal-sheet-target-resolver');
const spreadsheetController = require('../core/universal-spreadsheet-domain-controller');

const url = 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890/edit';

const generic = control.claim(`Enrich missing decision maker contacts, phones and emails in this spreadsheet: ${url}`);
assert.equal(generic.exclusive, true);
assert.equal(generic.domain, 'spreadsheet-enrichment');
assert.equal(generic.controller, 'universal-spreadsheet-domain-controller');
assert.equal(generic.generalModelAllowed, false);

const flexible = control.claim(`Research and fill missing people data in ${url}; analyze the columns and populate verified contacts.`);
assert.equal(flexible.domain, 'spreadsheet-enrichment');
assert.equal(flexible.controller, 'universal-spreadsheet-domain-controller');

// Historical explicit 3-POC wording keeps its compatibility route. That
// controller delegates Google execution to the universal deterministic engine.
const legacyWordingOnGoogle = control.claim(`Run anchored 3-POC enrichment on ${url}. POC 1, POC 2 and POC 3 must be completed.`);
assert.equal(legacyWordingOnGoogle.domain, 'three-poc-spreadsheet');
assert.equal(legacyWordingOnGoogle.controller, 'three-poc-domain-controller');
assert.equal(legacyWordingOnGoogle.generalModelAllowed, false);

const localLegacy = control.claim('Run anchored 3-POC enrichment on this workbook. POC 1, POC 2 and POC 3 must be completed.', {
  attachments: [{ id: 'file-1', name: 'contacts.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }],
});
assert.equal(localLegacy.domain, 'three-poc-spreadsheet');
assert.equal(localLegacy.controller, 'three-poc-domain-controller');

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
assert.equal(spreadsheetController.parseSheetName('Target only the `Arya 2` worksheet.'), 'Arya 2');
assert.equal(spreadsheetController.parseSheetName('Use only the Arya 2 worksheet.'), 'Arya 2');
assert.equal(spreadsheetController.parseSheetName('Target worksheet: "Arya 2"'), 'Arya 2');
assert.equal(spreadsheetController.parseSheetName('Target tab: "Arya 2"'), 'Arya 2');
assert.equal(
  spreadsheetController.parseSheetName('Enrich all POCs together on the "Arya 2" worksheet in:'),
  'Arya 2',
  '"on the <name> worksheet" production wording must resolve the exact tab',
);
assert.equal(
  spreadsheetController.parseSheetName('Run coordinated enrichment on the Arya 2 worksheet.'),
  'Arya 2',
  'unquoted on-the worksheet wording must resolve the exact tab',
);

assert.match(spreadsheetController.rowLimitNotice(8), /VALIDATION MODE IS ACTIVE/i);
assert.match(spreadsheetController.rowLimitNotice(8), /first 8 non-empty data rows/i);
assert.match(spreadsheetController.rowLimitNotice(undefined), /FULL-SHEET MODE/i);
assert.equal(spreadsheetController.parseFullSheetRequested('Run the full-sheet enrichment on Arya 2.'), true);
assert.equal(spreadsheetController.parseFullSheetRequested('Validate the first rows only.'), false);
const previousUniversalLimit = process.env.ULTRON_M3_UNIVERSAL_ENRICHMENT_ROW_LIMIT;
process.env.ULTRON_M3_UNIVERSAL_ENRICHMENT_ROW_LIMIT = '15';
assert.equal(spreadsheetController.configuredRowLimit('Validate Arya 2.'), 15);
assert.equal(spreadsheetController.configuredRowLimit('Fill the entire worksheet with no row limit.'), undefined);
if (previousUniversalLimit == null) delete process.env.ULTRON_M3_UNIVERSAL_ENRICHMENT_ROW_LIMIT;
else process.env.ULTRON_M3_UNIVERSAL_ENRICHMENT_ROW_LIMIT = previousUniversalLimit;

const meta = {
  sheets: [
    { properties: { title: 'Divya', sheetId: 111, index: 0 } },
    { properties: { title: 'Arya 2', sheetId: 222, index: 1 } },
    { properties: { title: 'Gaurav 2', sheetId: 333, index: 2 } },
  ],
};

assert.equal(
  spreadsheetController.recoverMentionedSheetName(
    meta,
    'Enrich all POCs together on the "Arya 2" worksheet in the supplied Google Sheet.'
  ),
  'Arya 2',
  'metadata-aware targeting must recover the exact mentioned worksheet even if phrase parsing misses',
);
assert.equal(
  spreadsheetController.recoverMentionedSheetName(
    meta,
    'Enrich contacts on the workbook.'
  ),
  '',
  'metadata-aware targeting must not guess a tab when no exact tab title is mentioned',
);

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

const mentionOverride = targetResolver.resolveTabs(meta, aryaUrl, {
  sheetName: 'Gaurav 2',
  explicitNameAuthoritative: true,
});
assert.equal(mentionOverride.target.name, 'Gaurav 2');
assert.equal(mentionOverride.target.sheetId, 333);
assert.equal(mentionOverride.targetSource, 'explicit-name-over-mention-gid');
assert.equal(mentionOverride.ignoredViewGid, 222);

// Explicit worksheet names are authoritative even when Google metadata is
// incomplete/scoped. The downstream exact A1 Values read is the real existence
// check, so metadata omission must not produce UNIVERSAL_SHEET_TAB_NOT_FOUND.
const incompleteMeta = {
  sheets: [
    { properties: { title: 'Divya', sheetId: 111, index: 0 } },
  ],
};
const metadataMissBypass = targetResolver.resolveTabs(incompleteMeta, aryaUrl, {
  sheetName: 'Arya 2',
  explicitNameAuthoritative: true,
});
assert.equal(metadataMissBypass.targeted, true);
assert.equal(metadataMissBypass.target.name, 'Arya 2');
assert.equal(metadataMissBypass.target.sheetId, null);
assert.equal(metadataMissBypass.target.synthetic, true);
assert.equal(metadataMissBypass.metadataFallback, true);
assert.equal(metadataMissBypass.targetSource, 'explicit-name-metadata-miss-bypass');
assert.equal(metadataMissBypass.ignoredViewGid, 222);

const emptyMetadataBypass = targetResolver.resolveTabs({ sheets: [] }, aryaUrl, {
  sheetName: 'Arya 2',
  explicitNameAuthoritative: true,
});
assert.equal(emptyMetadataBypass.targeted, true);
assert.equal(emptyMetadataBypass.target.name, 'Arya 2');
assert.equal(emptyMetadataBypass.target.synthetic, true);
assert.equal(emptyMetadataBypass.metadataFallback, true);
assert.equal(emptyMetadataBypass.targetSource, 'explicit-name-metadata-empty-bypass');

assert.throws(
  () => targetResolver.resolveTabs(meta, `${url}#gid=999`, {}),
  (error) => error && error.code === 'UNIVERSAL_SHEET_GID_NOT_FOUND'
);

const untargeted = targetResolver.resolveTabs(meta, url, {});
assert.equal(untargeted.targeted, false);
assert.equal(untargeted.targetSource, 'none');
assert.equal(untargeted.targets.length, 3);

console.log('Universal spreadsheet routing self-test passed: generic Google enrichment ownership, isolated 3-POC compatibility, quoted tab/worksheet parsing, direct URL conflict safety, explicit-tab-over-mention-gid targeting, metadata-miss/empty-metadata exact-name bypass, and visible validation/full-sheet mode are protected.');
