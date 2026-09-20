'use strict';

const assert = require('assert/strict');
const errors = require('../core/spreadsheet-enrichment-errors');

function title(error, context) {
  return errors.normalize(error, context).humanTitle;
}

function normalized(error, context) {
  return errors.normalize(error, context);
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
  'Groq API key is missing, expired, or invalid',
);

assert.equal(
  title(Object.assign(new Error('request timed out'), {
    subsystem: 'NVIDIA',
    errorType: 'TIMEOUT',
  })),
  'NVIDIA took too long to respond',
);

assert.equal(
  title(Object.assign(new Error('invalid API key'), {
    subsystem: 'APOLLO',
    status: 401,
  })),
  'Apollo API key is missing, expired, or invalid',
);

assert.equal(
  title(Object.assign(new Error('forbidden'), {
    subsystem: 'APOLLO',
    status: 403,
  })),
  'Apollo account does not have permission for this request',
);

assert.equal(
  title(Object.assign(new Error('request timed out'), {
    subsystem: 'APOLLO',
    errorType: 'TIMEOUT',
  })),
  'Apollo took too long to respond',
);

assert.equal(
  title(Object.assign(new Error('permission denied'), {
    subsystem: 'GOOGLE_SHEETS',
    status: 403,
  })),
  'Google Sheets access permission was denied',
);

assert.equal(
  title(Object.assign(new Error('quota exceeded'), {
    subsystem: 'GOOGLE_SHEETS',
    status: 429,
  })),
  'Google Sheets usage limit was reached',
);

assert.equal(
  title(Object.assign(new Error('invalid session'), {
    subsystem: 'LINKEDIN',
    status: 401,
  })),
  'LinkedIn session or login is no longer valid',
);

assert.equal(
  title(Object.assign(new Error('rate limited'), {
    subsystem: 'LINKEDIN',
    status: 429,
  })),
  'LinkedIn safety or usage limit reached',
);

assert.equal(
  title(Object.assign(new Error('invalid API key'), {
    subsystem: 'GEMINI',
    status: 401,
  })),
  'Gemini API key is missing, expired, or invalid',
);

const apolloRateMeta = normalized(Object.assign(new Error('Too many requests'), {
  status: 429,
  endpoint: 'https://api.apollo.io/api/v1/people/match',
}));
assert.equal(apolloRateMeta.code, 'APOLLO_RATE_LIMIT');

const googleAuthMeta = normalized(Object.assign(new Error('Invalid Credentials'), {
  status: 401,
  endpoint: 'https://sheets.googleapis.com/v4/spreadsheets/example',
}));
assert.equal(googleAuthMeta.code, 'GOOGLE_SHEETS_AUTH_FAILED');

const linkedinRateMeta = normalized(Object.assign(new Error('rate limited'), {
  subsystem: 'LINKEDIN',
  status: 429,
}));
assert.equal(linkedinRateMeta.code, 'LINKEDIN_RATE_LIMIT');

const groqAuthMeta = normalized(Object.assign(new Error('invalid API key'), {
  subsystem: 'GROQ',
  status: 401,
}));
assert.equal(groqAuthMeta.code, 'GROQ_AUTH_FAILED');

assert.equal(
  title(Object.assign(new Error('LinkedIn safety cooldown is active'), {
    code: 'LINKEDIN_COOLDOWN_ACTIVE',
    subsystem: 'LINKEDIN',
  })),
  'LinkedIn safety cooldown is active',
);

const linkedinDaily = normalized(Object.assign(new Error('LinkedIn daily safety cap reached'), {
  code: 'LINKEDIN_DAILY_CAP',
  subsystem: 'LINKEDIN',
}));
assert.equal(linkedinDaily.humanTitle, 'LinkedIn daily safety limit reached');
assert.equal(linkedinDaily.type, 'RATE_LIMIT');
assert.match(linkedinDaily.hint, /daily/i);
assert.match(linkedinDaily.hint, /(reset|wait)/i);
assert.match(linkedinDaily.hint, /(do not bypass|account-safety)/i);

const linkedinHourly = normalized(Object.assign(new Error('LinkedIn hourly safety cap reached'), {
  code: 'LINKEDIN_HOURLY_CAP',
  subsystem: 'LINKEDIN',
}));
assert.equal(linkedinHourly.humanTitle, 'LinkedIn hourly safety limit reached');
assert.equal(linkedinHourly.type, 'RATE_LIMIT');
assert.match(linkedinHourly.hint, /hourly/i);
assert.match(linkedinHourly.hint, /(reset|wait)/i);
assert.match(linkedinHourly.hint, /(do not bypass|account-safety)/i);

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

for (const sample of [
  title(Object.assign(new Error('invalid'), { subsystem: 'APOLLO', status: 401 })),
  title(Object.assign(new Error('invalid'), { subsystem: 'GOOGLE_SHEETS', status: 401 })),
  title(Object.assign(new Error('rate'), { subsystem: 'LINKEDIN', status: 429 })),
  title(Object.assign(new Error('rate'), { subsystem: 'GEMINI', status: 429 })),
]) {
  assert.doesNotMatch(sample, /[A-Z]{3,}_[A-Z0-9_]+/, 'human problem names must not expose machine error codes');
}

console.log('Human error vocabulary self-test passed: provider limits, auth failures, network failures, LinkedIn safety states and daily/hourly caps, worksheet targeting, schema failures, candidate exhaustion and internal recursion are named in plain English with a clear explanation and next action.');
