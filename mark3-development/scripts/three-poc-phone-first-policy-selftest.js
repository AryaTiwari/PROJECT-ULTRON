'use strict';

const assert = require('node:assert/strict');
const policy = require('../core/three-poc-phone-first-policy');

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

console.log('Three-POC phone-first policy selftest: PASS');
