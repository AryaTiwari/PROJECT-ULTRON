const assert = require('assert');
const fs = require('fs');
const path = require('path');

const quality = require('../core/apollo-three-poc-quality');
const apollo = require('../core/apollo-enrichment');

// Apollo request IDs are signed 64-bit values; never round them through JS Number.
assert.equal(
  quality.requestIdFromRaw('{"request_id":1039995589705121975,"waterfall":{"status":"accepted"}}'),
  '1039995589705121975'
);
assert.equal(
  quality.requestIdFromRaw('{"request_id":-1039995589705121975}'),
  '-1039995589705121975'
);

// Prefer business/work email evidence and never silently upgrade quality by using
// personal/private mailboxes.
assert.equal(quality.emailFromPayload({ people: [{ emails: [
  { email: 'private.person@gmail.com', type: 'personal' },
  { email: 'recruiter@company.com', type: 'work' },
] }] }), 'recruiter@company.com');
assert.equal(quality.emailFromPayload({ people: [{ emails: [
  { email: 'private.person@gmail.com', type: 'personal' },
] }] }), null);
assert.equal(quality.emailFromPayload({ people: [{ email: 'person@company.com' }] }), 'person@company.com');

// Phone preference is India-first whenever Apollo exposes multiple valid numbers.
// Explicit Indian country evidence is normalized to canonical +91 form, while a
// foreign number remains a valid fallback when no Indian number exists.
assert.equal(
  apollo.preferredPhoneFromPayload({
    phone_numbers: [
      { sanitized_number: '+1 415 555 0100', country_code: 'US' },
      { sanitized_number: '98765 43210', country_code: 'IN' },
    ],
  }),
  '+919876543210'
);
assert.equal(
  apollo.preferredPhoneFromPayload({
    phone_numbers: [
      { sanitized_number: '+44 20 7946 0958', country_code: 'GB' },
      { sanitized_number: '+91 99887 76655', country_code: 'IN' },
    ],
  }),
  '+919988776655'
);
assert.equal(
  apollo.preferredPhoneFromPayload({
    phone_numbers: [{ sanitized_number: '+1 650 555 0182', country_code: 'US' }],
  }),
  '+1 650 555 0182'
);
assert.equal(
  quality.phoneFromPayload({
    person: {
      phone_numbers: [
        { raw_number: '+1 212 555 0101', country: 'United States' },
        { raw_number: '9123456789', country: 'India' },
      ],
    },
  }),
  '+919123456789'
);

const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'apollo-three-poc-quality.js'), 'utf8');
const controller = fs.readFileSync(path.join(__dirname, '..', 'core', 'three-poc-domain-controller.js'), 'utf8');

assert.match(source, /run_waterfall_email', 'true'/);
assert.match(source, /run_waterfall_phone', 'false'/);
assert.match(source, /reveal_personal_emails', 'false'/);
assert.match(source, /reveal_phone_number', 'false'/);
assert.match(source, /poll_only', 'true'/);
assert.match(source, /ULTRON_M3_THREE_POC_EMAIL_WATERFALL_MAX', 30/);
assert.match(source, /ULTRON_M3_THREE_POC_EMAIL_WATERFALL_COOLDOWN_DAYS', 14/);
assert.match(source, /resolveDecisionMaker = async function resultsFirstResolveDecisionMaker/);
assert.match(source, /resolvePersonByNameCompany = async function resultsFirstResolvePersonByNameCompany/);
assert.match(source, /resolvePersonByBusinessEmail = async function resultsFirstResolvePersonByBusinessEmail/);
assert.match(source, /resolvePersonProfile = async function resultsFirstResolvePersonProfile/);
assert.match(source, /ULTRON_M3_THREE_POC_PHONE_WATERFALL_EXPERIMENTAL', '0'/);
assert.match(source, /Native Apollo reveal \+ webhook settlement is the production default/);
assert.match(source, /function pendingPhoneWaterfallRequestId/);
assert.match(source, /function carryLegacyPhoneRequest/);
assert.match(source, /const pendingWasCarried = Boolean/);
assert.match(source, /result\?\.phoneWaterfallRequestId/);
assert.match(source, /apollo\.fetchApolloResponse/);
assert.doesNotMatch(source, /\bawait fetch\(/, 'contact-quality Apollo traffic must use the typed retry helper');
assert.doesNotMatch(source, /apollo\.enrich\s*=/, 'generic Apollo enrich must not be monkey-patched');
assert.match(controller, /apollo-three-poc-quality/);
assert.match(controller, /apolloQuality\.startRun\(\)/);

const previousEmailWaterfallMax = process.env.ULTRON_M3_THREE_POC_EMAIL_WATERFALL_MAX;
const previousPhoneWaterfall = process.env.ULTRON_M3_THREE_POC_PHONE_WATERFALL_EXPERIMENTAL;

// This self-test verifies code defaults, not deployment-specific .env overrides.
delete process.env.ULTRON_M3_THREE_POC_EMAIL_WATERFALL_MAX;
delete process.env.ULTRON_M3_THREE_POC_PHONE_WATERFALL_EXPERIMENTAL;

quality.startRun();
const stats = quality.stats();
assert.equal(stats.maxWaterfalls, 30);
assert.equal(stats.personalEmailReveal, false);
assert.equal(stats.phoneWaterfall, false);
assert.equal(stats.scope, 'final-verified-pocs-only');
assert.equal(stats.waterfallStarted, 0);

if (previousEmailWaterfallMax == null) delete process.env.ULTRON_M3_THREE_POC_EMAIL_WATERFALL_MAX;
else process.env.ULTRON_M3_THREE_POC_EMAIL_WATERFALL_MAX = previousEmailWaterfallMax;

if (previousPhoneWaterfall == null) delete process.env.ULTRON_M3_THREE_POC_PHONE_WATERFALL_EXPERIMENTAL;
else process.env.ULTRON_M3_THREE_POC_PHONE_WATERFALL_EXPERIMENTAL = previousPhoneWaterfall;

console.log('3-POC Apollo quality self-test passed: native Apollo phone reveal is the production default, already-paid legacy phone waterfalls remain resumable, bounded work-email waterfall fallback is preserved, personal-email reveal stays off, and paid retries remain capped/cached.');
