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
assert.equal(apolloTyped.humanTitle, 'Apollo could not be reached after automatic retries');
assert.match(errors.format(apolloTyped), /^Problem: Apollo could not be reached after automatic retries\./);
assert.doesNotMatch(errors.format(apolloTyped), /APOLLO_NETWORK_FETCH_FAILED|\[APOLLO\/NETWORK\]/);

const apolloRate = Object.assign(new Error('HTTP 429 resource exhausted'), {
  code: 'APOLLO_RATE_LIMIT',
  subsystem: 'APOLLO',
  stage: 'candidate-discovery',
});
const apolloRateTyped = errors.normalize(apolloRate);
assert.equal(apolloRateTyped.type, 'RATE_LIMIT');
assert.equal(apolloRateTyped.humanTitle, 'Apollo rate limit reached');
assert.match(errors.format(apolloRateTyped), /Problem: Apollo rate limit reached\./);

const sheetsAuth = Object.assign(new Error('Authorization required'), {
  code: 'GOOGLE_SHEETS_AUTH_REQUIRED',
  stage: 'sheet-values-read',
});
const sheetsTyped = errors.normalize(sheetsAuth);
assert.equal(sheetsTyped.subsystem, 'GOOGLE_SHEETS');
assert.equal(sheetsTyped.type, 'AUTH');
assert.equal(sheetsTyped.humanTitle, 'Google Sheets authorization expired or is invalid');

const tabMissing = Object.assign(new Error('Google Sheet tab not found: Arya 2'), {
  code: 'UNIVERSAL_SHEET_TAB_NOT_FOUND',
});
const tabTyped = errors.normalize(tabMissing, { stage: 'worksheet-target-resolution' });
assert.equal(tabTyped.subsystem, 'TARGETING');
assert.equal(tabTyped.type, 'NOT_FOUND');
assert.equal(tabTyped.humanTitle, 'The requested worksheet tab could not be found');

const schema = Object.assign(new Error('Schema confidence too low'), {
  code: 'UNIVERSAL_SCHEMA_CONFIDENCE_TOO_LOW',
});
const schemaTyped = errors.normalize(schema, { stage: 'schema-confidence-gate' });
assert.equal(schemaTyped.subsystem, 'SCHEMA');
assert.equal(schemaTyped.type, 'SCHEMA');
assert.equal(schemaTyped.humanTitle, 'Spreadsheet columns could not be identified safely');

const linkedinBusy = Object.assign(new Error('Another LinkedIn MCP client is currently using the browser.'), {
  code: 'LINKEDIN_MCP_TOOL_ERROR',
  subsystem: 'LINKEDIN',
});
const linkedinBusyTyped = errors.normalize(linkedinBusy);
assert.equal(linkedinBusyTyped.humanTitle, 'LinkedIn browser is already busy');

const pickle = Object.assign(new Error('Big Pickle unavailable'), {
  code: 'BIG_PICKLE_OPENCODE_DISABLED',
});
const pickleTyped = errors.normalize(pickle, { stage: 'fallback-reasoning' });
assert.equal(pickleTyped.subsystem, 'BIG_PICKLE');

const humanTypeMatrix = [
  ['APOLLO', 'RATE_LIMIT', 'Apollo rate limit reached'],
  ['APOLLO', 'AUTH', 'Apollo API key is missing, expired, or invalid'],
  ['APOLLO', 'PERMISSION', 'Apollo account does not have permission for this request'],
  ['APOLLO', 'NETWORK', 'Apollo could not be reached'],
  ['APOLLO', 'TIMEOUT', 'Apollo took too long to respond'],
  ['APOLLO', 'CONFIG', 'Apollo is not configured correctly'],
  ['GOOGLE_SHEETS', 'AUTH', 'Google Sheets authorization expired or is invalid'],
  ['GOOGLE_SHEETS', 'PERMISSION', 'Google Sheets access permission was denied'],
  ['GOOGLE_SHEETS', 'RATE_LIMIT', 'Google Sheets usage limit was reached'],
  ['GOOGLE_SHEETS', 'INVALID_RANGE', 'Google Sheets range is invalid'],
  ['LINKEDIN', 'AUTH', 'LinkedIn session or login is no longer valid'],
  ['LINKEDIN', 'RATE_LIMIT', 'LinkedIn safety or usage limit reached'],
  ['GEMINI', 'AUTH', 'Gemini API key is missing, expired, or invalid'],
  ['GROQ', 'AUTH', 'Groq API key is missing, expired, or invalid'],
  ['NVIDIA', 'TIMEOUT', 'NVIDIA took too long to respond'],
  ['TARGETING', 'TARGETING', 'Worksheet name or tab could not be resolved'],
  ['SCHEMA', 'SCHEMA', 'Spreadsheet columns could not be understood safely'],
  ['LINKEDIN', 'NOT_FOUND', 'LinkedIn could not find the requested record'],
  ['LINKEDIN', 'AMBIGUITY', 'LinkedIn found conflicting or ambiguous evidence'],
  ['GEMINI', 'BAD_REQUEST', 'Gemini rejected the request as invalid'],
  ['UNIVERSAL', 'RECURSION', 'ULTRON hit an internal recursive loop'],
  ['NVIDIA', 'API', 'NVIDIA returned an API error'],
  ['UNIVERSAL', 'INTERNAL', 'ULTRON enrichment encountered an internal error'],
];
for (const [subsystem, type, expected] of humanTypeMatrix) {
  assert.equal(errors.humanTitleFor(subsystem, type, 'TEST_CODE', 'test failure'), expected);
}

console.log('Spreadsheet error taxonomy self-test passed: machine codes remain available for debugging while Apollo, Google Sheets, LinkedIn, targeting, schema and fallback failures render as plain-English problem names.');
