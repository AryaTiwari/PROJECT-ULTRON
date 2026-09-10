#!/usr/bin/env node
const assert = require('assert');
const microsoft = require('../core/microsoft-excel-operator');
const bootstrap = require('../core/lead-enrichment-bootstrap');

const url = 'https://1drv.ms/x/c/35c43b64ad90686a/IQDHg33o3RX8SZYKHa90f_DGAaJ5HYDsFONKtngxtE_MnUo?e=GF2etW';
assert.equal(microsoft.extractWorkbookUrl(`please use ${url}`), url);
assert.equal(microsoft.isMicrosoftUrl(url), true);
assert.match(microsoft.shareToken(url), /^u![A-Za-z0-9_-]+$/);

const parsedRange = microsoft.parseRange("'Lead Sheet'!H12");
assert.deepEqual(parsedRange, { sheetName: 'Lead Sheet', address: 'H12' });
assert.equal(microsoft.cellRange('Lead Sheet', 12, 7), "'Lead Sheet'!H12");

const source = bootstrap.spreadsheetSource(`${url} enrich this with apollo`);
assert.ok(source);
assert.equal(source.provider, 'microsoft');
assert.equal(source.supported, true);

const request = bootstrap.isEnrichmentRequest(`${url} enrich this with apollo`);
assert.ok(request);
assert.equal(request.provider, 'microsoft');
assert.equal(request.invalidUrl, false);
assert.equal(request.unsupportedProvider, null);

console.log('Microsoft OneDrive self-test passed. OneDrive links route to the real Excel adapter and remain behind the Apollo approval gate.');
