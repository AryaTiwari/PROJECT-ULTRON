'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const policy = require('../core/three-poc-phone-first-policy');
const operatorSource = fs.readFileSync(path.join(__dirname, '..', 'core', 'three-poc-enrichment-operator.js'), 'utf8');
const policySource = fs.readFileSync(path.join(__dirname, '..', 'core', 'three-poc-phone-first-policy.js'), 'utf8');
const apolloSource = fs.readFileSync(path.join(__dirname, '..', 'core', 'apollo-enrichment.js'), 'utf8');

assert.equal(policy.INDIA_SEARCH_ATTEMPTS.length, 5);
assert.equal(new Set(policy.INDIA_SEARCH_ATTEMPTS.map((item) => item.id)).size, 5);
assert.equal(new Set(policy.INDIA_SEARCH_ATTEMPTS.map((item) => item.titles.join('|'))).size, 5);
assert.equal(policy.strictIndianMobile('+91 98765 43210'), '+919876543210');
assert.equal(policy.strictIndianMobile('9876543210', 'India'), '+919876543210');
assert.equal(policy.strictIndianMobile('1234567890', 'India'), '');
assert.equal(policy.strictIndianMobile('+1 415 555 0100'), '');
assert.equal(policy.isIndiaLocated({ location: 'Bengaluru, India' }), true);
assert.equal(policy.isIndiaLocated({ location: 'Indianapolis, USA' }), false);
assert.equal(policy.phonePriority({ phone: '+91 9876543210' }), 4);
assert.equal(policy.phonePriority({ location: 'Mumbai, India', hasDirectPhone: true }), 3);
assert.equal(policy.phonePriority({ location: 'Mumbai, India', directPhoneAvailability: 1 }), 1);
assert.equal(policy.phonePriority({ phone: '+1 415 555 0100' }), 2);
assert.equal(policy.phonePriority({ location: 'Mumbai, India' }), 1);
assert.equal(policy.canUseInternationalFallback(4, false), false);
assert.equal(policy.canUseInternationalFallback(5, false), true);
assert.equal(policy.canUseInternationalFallback(5, true), false);

const merged = policy.mergeCandidates([
  [{ id: 'same', location: 'Mumbai, India' }, { id: 'global', phone: '+1 415 555 0100' }],
  [{ id: 'same', phone: '+91 9876543210' }, { id: 'other', name: 'Another contact' }],
]);
assert.equal(merged.length, 3);
assert.equal(merged.find((item) => item.id === 'same').phone, '+91 9876543210');

// Static wiring checks prevent the policy from silently becoming an unused helper.
assert.match(operatorSource, /phoneFirstPolicy\.discoverCandidates/);
assert.match(policySource, /INDIA_SEARCH_ATTEMPTS/);
assert.match(policySource, /location:\s*'India'/);
assert.match(policySource, /canUseInternationalFallback\(attemptsCompleted, verifiedIndianPhoneFound\)/);
assert.match(operatorSource, /PHONE_FIRST_POLICY_VERSION/);
assert.match(operatorSource, /THREE_POC_RESUME_POLICY_MISMATCH/);
assert.match(policySource, /stats\.indiaPhoneSearchAttempts/);
assert.match(policySource, /stats\.internationalFallbackSearches/);
assert.match(apolloSource, /country_name:\s*String\(person\?\.country_name/);

(async () => {
  const calls = [];
  const stats = {};
  const globalFallback = await policy.discoverCandidates({
    company: 'Northstar Labs',
    domain: 'northstar.example',
    limit: 20,
    hiringCandidateTitles: ['founder', 'director'],
    stats,
    searchCompanyPeopleBroad: async (args) => {
      calls.push(args);
      if (args.location === 'India') {
        return { people: [{ id: `india-${calls.length}`, name: `India Candidate ${calls.length}`, location: 'Mumbai, India', has_direct_phone: 'Maybe' }] };
      }
      return { people: [{ id: 'global-founder', name: 'Global Founder', title: 'Founder', phone: '+1 415 555 0100' }] };
    },
  });
  assert.equal(calls.filter((call) => call.location === 'India').length, 5);
  assert.equal(calls.length, 6, 'international fallback must happen only after all five India searches');
  assert.equal(calls.slice(0, 5).every((call) => call.location === 'India'), true);
  assert.equal(calls.slice(0, 5).every((call) => Array.isArray(call.titles) && call.titles.length > 0), true);
  assert.equal(new Set(calls.slice(0, 5).map((call) => call.titles.join('|'))).size, 5);
  assert.equal(calls[5].location, undefined, 'international fallback must remove the India location constraint');
  assert.equal(globalFallback.indiaSearchAttempts, 5);
  assert.equal(globalFallback.internationalFallbackUsed, true);
  assert.equal(stats.indiaPhoneSearchAttempts, 5);
  assert.equal(stats.internationalFallbackSearches, 1);
  assert.equal(globalFallback.people.some((person) => person.id === 'global-founder'), true);

  const earlyCalls = [];
  const earlyStats = {};
  const earlyStop = await policy.discoverCandidates({
    company: 'Northstar Labs',
    domain: 'northstar.example',
    stats: earlyStats,
    searchCompanyPeopleBroad: async (args) => {
      earlyCalls.push(args);
      if (args.titles.includes('talent acquisition')) {
        return { people: [{ id: 'india-verified', name: 'India Decision Maker', location: 'Mumbai, India', phone: '+91 9876543210' }] };
      }
      return { people: [{ id: 'india-other', name: 'India Other', location: 'Bengaluru, India', has_direct_phone: 'Maybe' }] };
    },
  });
  assert.equal(earlyCalls.length, 2, 'bounded parallel batch should finish, then stop after verified +91 is found');
  assert.equal(earlyCalls.every((call) => call.location === 'India'), true);
  assert.equal(earlyStop.verifiedIndianPhoneFound, true);
  assert.equal(earlyStop.internationalFallbackUsed, false);
  assert.equal(earlyStats.internationalFallbackSearches || 0, 0);
  assert.equal(earlyStats.verifiedIndianPhoneCandidates, 1);

  console.log('Three-POC phone-first policy selftest: PASS (five-search fallback gate, early verified +91 stop, ranking, cache policy wiring)');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
