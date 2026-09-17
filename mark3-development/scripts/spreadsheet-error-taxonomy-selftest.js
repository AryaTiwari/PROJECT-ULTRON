'use strict';

const assert = require('assert/strict');
const errors = require('../core/spreadsheet-enrichment-errors');

const apolloFetch = new TypeError('Failed to fetch');
apolloFetch.stack = 'TypeError: Failed to fetch\n    at searchCompanyPeopleBroad (core/apollo-enrichment.js:312:24)';
const apolloTyped = errors.normalize(apolloFetch, { stage: 'candidate-discovery' });
assert.equal(apolloTyped.subsystem, 'APOLLO');
assert.equal(apolloTyped.type, 'NETWORK');
assert.equal(apolloTyped.code, 'APOLLO_NETWORK_FETCH_FAILED');
assert.equal(apolloTyped.stage, 'candidate-discovery');
assert.match(errors.format(apolloTyped), /^\[APOLLO\/NETWORK\] APOLLO_NETWORK_FETCH_FAILED @ candidate-discovery:/);

const sheetsAuth = Object.assign(new Error('Authorization required'), { code: 'GOOGLE_SHEETS_AUTH_REQUIRED', stage: 'sheet-values-read' });
const sheetsTyped = errors.normalize(sheetsAuth);
assert.equal(sheetsTyped.subsystem, 'GOOGLE_SHEETS');
assert.equal(sheetsTyped.type, 'AUTH');

const tabMissing = Object.assign(new Error('Google Sheet tab not found: Arya 2'), { code: 'UNIVERSAL_SHEET_TAB_NOT_FOUND' });
const tabTyped = errors.normalize(tabMissing, { stage: 'worksheet-target-resolution' });
assert.equal(tabTyped.subsystem, 'TARGETING');
assert.equal(tabTyped.type, 'NOT_FOUND');

const schema = Object.assign(new Error('Schema confidence too low'), { code: 'UNIVERSAL_SCHEMA_CONFIDENCE_TOO_LOW' });
const schemaTyped = errors.normalize(schema, { stage: 'schema-confidence-gate' });
assert.equal(schemaTyped.subsystem, 'SCHEMA');
assert.equal(schemaTyped.type, 'SCHEMA');

const pickle = Object.assign(new Error('Big Pickle unavailable'), { code: 'BIG_PICKLE_OPENCODE_DISABLED' });
const pickleTyped = errors.normalize(pickle, { stage: 'fallback-reasoning' });
assert.equal(pickleTyped.subsystem, 'BIG_PICKLE');

console.log('Spreadsheet error taxonomy self-test passed: raw fetch failures and Sheets/targeting/schema/Big-Pickle errors expose subsystem, type, code and stage.');
