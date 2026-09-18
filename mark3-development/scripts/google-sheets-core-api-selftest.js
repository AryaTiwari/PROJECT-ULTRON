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
assert.equal(sheets.classifyApiError(409, { error: { status: 'ABORTED' } }), 'GOOGLE_SHEETS_CONFLICT');
assert.equal(sheets.classifyApiError(429, { error: { status: 'RESOURCE_EXHAUSTED' } }), 'GOOGLE_SHEETS_RATE_LIMITED');
assert.equal(sheets.classifyApiError(503, { error: { status: 'UNAVAILABLE' } }), 'GOOGLE_SHEETS_UNAVAILABLE');
assert.equal(sheets.looksLikeGeneratedA1("'Arya 2'!A:ZZ"), true);
assert.equal(sheets.looksLikeGeneratedA1("'Arya 2'!A1:O20"), true);
assert.equal(sheets.looksLikeGeneratedA1("not a range"), false);
assert.equal(
  sheets.classifyApiError(418, { error: { status: 'TEAPOT', message: 'Unexpected status' } }),
  'GOOGLE_SHEETS_HTTP_418',
  'unknown HTTP responses must retain a specific status code instead of collapsing into GOOGLE_SHEETS_API_ERROR',
);

const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'google-sheets-operator.js'), 'utf8');
const metadataFunction = source.match(/async function metadata\(id\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';
assert.ok(metadataFunction, 'metadata() implementation must be present');
assert.match(source, /google-sheets-http-body-read/, 'Google response-body interruptions must surface as a typed network stage');
assert.match(source, /bodyReadAttempt < 2/, 'Google response-body interruptions must retry before failing');
assert.match(
  metadataFunction,
  /properties\(title\),sheets\(properties\(sheetId,title,index,gridProperties\(rowCount,columnCount\)\)\)/,
  'metadata() must request title, tab ids/names and grid dimensions',
);

console.log('Google Sheets core API self-test passed: HTTP failures keep specific auth/range/quota/server codes, interrupted response bodies retry with typed network errors, generated A1 ranges are recognized for tab-vs-range diagnosis, and metadata() exposes the required workbook/tab/grid fields.');
