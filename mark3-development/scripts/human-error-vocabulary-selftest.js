'use strict';

const assert = require('assert/strict');
const errors = require('../core/spreadsheet-enrichment-errors');

function title(error, context) {
  return errors.normalize(error, context).humanTitle;
}

assert.equal(
  title(Object.assign(new Error('Too many requests'), {
    status: 429,
    endpoint: 'https://api.apollo.io/api/v1/people/match',
  })),
  'Apollo rate limit reached',
);

assert.equal(
  title(Object.assign(new TypeError('Failed to fetch'), {
    endpoint: 'https://api.apollo.io/api/v1/people/match',
  })),
  'Apollo could not be reached after automatic retries',
);

assert.equal(
  title(Object.assign(new Error('Invalid Credentials'), {
    status: 401,
    endpoint: 'https://sheets.googleapis.com/v4/spreadsheets/example',
  })),
  'Google Sheets authorization expired or is invalid',
);

assert.equal(
  title(Object.assign(new Error('rate limit'), {
    subsystem: 'GEMINI',
    status: 429,
  })),
  'Gemini rate limit reached',
);

assert.equal(
  title(Object.assign(new Error('invalid API key'), {
    subsystem: 'GROQ',
    status: 401,
  })),
  'Groq authentication or API-key problem',
);

assert.equal(
  title(Object.assign(new Error('request timed out'), {
    subsystem: 'NVIDIA',
    errorType: 'TIMEOUT',
  })),
  'NVIDIA request timed out',
);

assert.equal(
  title(Object.assign(new Error('LinkedIn safety cooldown is active'), {
    code: 'LINKEDIN_COOLDOWN_ACTIVE',
    subsystem: 'LINKEDIN',
  })),
  'LinkedIn safety cooldown is active',
);

assert.equal(
  title(Object.assign(new Error('Another LinkedIn MCP client is currently using the browser'), {
    code: 'LINKEDIN_MCP_TOOL_ERROR',
    subsystem: 'LINKEDIN',
  })),
  'LinkedIn browser is already busy',
);

assert.equal(
  title(Object.assign(new Error('target required'), {
    code: 'UNIVERSAL_SHEET_TARGET_REQUIRED',
    subsystem: 'TARGETING',
  })),
  'Worksheet target is missing',
);

assert.equal(
  title(Object.assign(new Error('schema confidence too low'), {
    code: 'UNIVERSAL_SCHEMA_CONFIDENCE_TOO_LOW',
    subsystem: 'SCHEMA',
  })),
  'Spreadsheet columns could not be identified safely',
);

assert.equal(
  title(Object.assign(new Error('no verified candidate'), {
    code: 'POC2_NO_VERIFIED_CANDIDATE_AFTER_ALL_STRATEGIES',
    subsystem: 'DISCOVERY',
  })),
  'No verified same-company POC-2 could be found',
);

assert.equal(
  title(Object.assign(new RangeError('Maximum call stack size exceeded'), {
    code: 'UNIVERSAL_RECURSION_STACK_OVERFLOW',
  })),
  'ULTRON hit an internal recursive loop',
);

const formatted = errors.format(Object.assign(new Error('Too many requests'), {
  status: 429,
  endpoint: 'https://api.apollo.io/api/v1/people/match',
}));
assert.match(formatted, /^Problem: Apollo rate limit reached\./);
assert.match(formatted, /usage limit was reached/i);
assert.match(formatted, /What to do:/i);
assert.doesNotMatch(formatted, /APOLLO_[A-Z0-9_]+/);

const networkFormatted = errors.format(Object.assign(new TypeError('Failed to fetch'), {
  endpoint: 'https://api.apollo.io/api/v1/people/match',
}));
assert.match(networkFormatted, /^Problem: Apollo could not be reached after automatic retries\./);
assert.match(networkFormatted, /retried the Apollo request automatically/i);
assert.match(networkFormatted, /internet, DNS, firewall\/proxy/i);
assert.doesNotMatch(networkFormatted, /APOLLO_[A-Z0-9_]+/);

console.log('Human error vocabulary self-test passed: provider limits, auth failures, network failures, LinkedIn safety states, worksheet targeting, schema failures, candidate exhaustion and internal recursion are named in plain English with a clear explanation and next action.');
