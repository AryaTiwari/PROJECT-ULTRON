#!/usr/bin/env node
const assert = require('assert');
const leads = require('../core/lead-enrichment-bootstrap');

const google = leads.isEnrichmentRequest('Ultron, enrich this sheet with Apollo: https://docs.google.com/spreadsheets/d/abc123/edit');
assert.ok(google);
assert.equal(google.provider, 'google');
assert.equal(google.unsupportedProvider, null);
assert.equal(google.invalidUrl, false);

const oneDrive = leads.isEnrichmentRequest('https://1drv.ms/x/c/35c43b64ad90686a/example?e=test enrich this with apollo');
assert.ok(oneDrive);
assert.equal(oneDrive.provider, 'microsoft');
assert.equal(oneDrive.unsupportedProvider, 'microsoft');
assert.equal(oneDrive.invalidUrl, false);

const guard = leads.unsupportedSpreadsheetResponse(oneDrive);
assert.equal(guard.ok, false);
assert.equal(guard.provider, 'local-spreadsheet-guard');
assert.equal(guard.model, 'mark3-spreadsheet-guard');
assert.equal(guard.error, 'MICROSOFT_SPREADSHEET_ADAPTER_REQUIRED');
assert.equal(guard.apolloCalled, false);
assert.match(guard.text, /did not call Apollo/i);
assert.match(guard.text, /did not edit the workbook/i);

assert.equal(leads.isEnrichmentRequest('https://example.com/file enrich this with apollo'), null);

console.log('Spreadsheet routing self-test passed. Google Sheets routes to the real operator; OneDrive/Excel links are blocked before model fallback and cannot fabricate Apollo execution.');
