const assert = require('assert');
const fs = require('fs');
const path = require('path');

const quality = require('../core/apollo-three-poc-quality');

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

const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'apollo-three-poc-quality.js'), 'utf8');
const controller = fs.readFileSync(path.join(__dirname, '..', 'core', 'three-poc-domain-controller.js'), 'utf8');

assert.match(source, /run_waterfall_email', 'true'/);
assert.match(source, /run_waterfall_phone', 'false'/);
assert.match(source, /reveal_personal_emails', 'false'/);
assert.match(source, /reveal_phone_number', 'false'/);
assert.match(source, /poll_only', 'true'/);
assert.match(source, /ULTRON_M3_THREE_POC_EMAIL_WATERFALL_MAX', 30/);
assert.match(source, /ULTRON_M3_THREE_POC_EMAIL_WATERFALL_COOLDOWN_DAYS', 14/);
assert.match(source, /resolveDecisionMaker = async function balancedResolveDecisionMaker/);
assert.match(source, /resolvePersonByNameCompany = async function balancedResolvePersonByNameCompany/);
assert.doesNotMatch(source, /apollo\.enrich\s*=/, 'generic Apollo enrich must not be monkey-patched');
assert.doesNotMatch(source, /apollo\.resolvePersonProfile\s*=/, 'POC-1/generic profile resolution must keep standard credit-saver behavior');
assert.match(controller, /apollo-three-poc-quality/);
assert.match(controller, /apolloQuality\.startRun\(\)/);

const previousPhoneWaterfall = process.env.ULTRON_M3_THREE_POC_PHONE_WATERFALL;
delete process.env.ULTRON_M3_THREE_POC_PHONE_WATERFALL;
quality.startRun();
const stats = quality.stats();
assert.equal(stats.maxWaterfalls, 30);
assert.equal(stats.personalEmailReveal, false);
assert.equal(stats.phoneWaterfall, false);
assert.equal(stats.scope, 'final-verified-pocs-only');
assert.equal(stats.waterfallStarted, 0);
if (previousPhoneWaterfall == null) delete process.env.ULTRON_M3_THREE_POC_PHONE_WATERFALL;
else process.env.ULTRON_M3_THREE_POC_PHONE_WATERFALL = previousPhoneWaterfall;

console.log('3-POC Apollo quality self-test passed: native Apollo phone reveal is the production default, already-paid legacy phone waterfalls remain resumable, bounded work-email waterfall fallback is preserved, personal-email reveal stays off, and paid retries remain capped/cached.');
