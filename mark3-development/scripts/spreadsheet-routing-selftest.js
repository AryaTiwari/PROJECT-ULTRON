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
assert.equal(oneDrive.unsupportedProvider, null);
assert.equal(oneDrive.invalidUrl, false);
assert.equal(oneDrive.url, 'https://1drv.ms/x/c/35c43b64ad90686a/example?e=test');

const source = leads.spreadsheetSource(oneDrive.url);
assert.equal(source.provider, 'microsoft');
assert.equal(source.supported, true);

assert.equal(leads.isEnrichmentRequest('https://example.com/file enrich this with apollo'), null);

console.log('Spreadsheet routing self-test passed. Google Sheets and OneDrive/Excel links route deterministically to real spreadsheet adapters before any model fallback.');
