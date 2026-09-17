'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const sheets = require('../core/google-sheets-operator');

assert.equal(sheets.classifyApiError(400, { error: { status: 'INVALID_ARGUMENT', message: 'Bad request' } }), 'GOOGLE_SHEETS_BAD_REQUEST');
assert.equal(sheets.classifyApiError(400, { error: { status: 'INVALID_ARGUMENT', message: 'Unable to parse range: Arya X' } }), 'GOOGLE_SHEETS_RANGE_INVALID');
assert.equal(sheets.classifyApiError(401, { error: { status: 'UNAUTHENTICATED' } }), 'GOOGLE_SHEETS_AUTH_REQUIRED');
assert.equal(sheets.classifyApiError(403, { error: { status: 'PERMISSION_DENIED' } }), 'GOOGLE_SHEETS_FORBIDDEN');
assert.equal(sheets.classifyApiError(404, { error: { status: 'NOT_FOUND' } }), 'GOOGLE_SHEETS_NOT_FOUND');
assert.equal(sheets.classifyApiError(429, { error: { status: 'RESOURCE_EXHAUSTED' } }), 'GOOGLE_SHEETS_RATE_LIMITED');
assert.equal(sheets.classifyApiError(503, { error: { status: 'UNAVAILABLE' } }), 'GOOGLE_SHEETS_UNAVAILABLE');

const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'google-sheets-operator.js'), 'utf8');
assert.match(
  source,
  /properties\(title\),sheets\(properties\(sheetId,title,index,gridProperties\(rowCount,columnCount\)\)\)/,
  'metadata fields selector must use valid nested Google partial-response syntax',
);
assert.doesNotMatch(source, /sheets\.properties\(/, 'legacy dotted metadata selector must not return');
assert.doesNotMatch(source, /:\s*'GOOGLE_SHEETS_API_ERROR'/, 'core request path must not collapse unknown HTTP responses into the old generic API error');

console.log('Google Sheets core API self-test passed: metadata selector syntax is valid and HTTP failures retain specific auth/range/quota/server error classes.');
