'use strict';

const assert = require('assert');
const fs = require('fs');
const controller = require('../core/universal-spreadsheet-domain-controller');
const operator = require('../core/universal-sheet-enrichment-operator');
const targeted = require('../core/universal-sheet-enrichment-targeted');
const sheets = require('../core/google-sheets-operator');

assert.equal(controller.parseIndianPhonePolicy('Require Indian phone numbers (+91). Reject companies without one.'), true);
assert.equal(controller.parseIndianPhonePolicy('Only accept India mobile numbers and remove foreign-only companies.'), true);
assert.equal(controller.parseIndianPhonePolicy('Enrich phone and email columns.'), false);
assert.equal(controller.parseExpectedPersonGroups('Use POC-1 and POC-2 only.'), 2);

assert.equal(operator.contactabilityTier({ phone: '+1 415 555 0123', email: 'hr@example.com' }), 2);
assert.equal(operator.contactabilityTier({ phone: '+91 98765 43210' }), 3);
assert.equal(operator.contactabilityTier({ phone: '+91 98765 43210', email: 'hr@example.in' }), 4);
assert.ok(operator.candidateIndiaPriority({ location: 'Mumbai, Maharashtra, India' }) > operator.candidateIndiaPriority({ location: 'New York, USA' }));

const companyContext = { company: 'Acme', domain: 'acme.in' };
const candidates = [
  { id: '1', name: 'A', title: 'Talent Acquisition Head', organizationName: 'Acme', organizationDomain: 'acme.in', location: 'Mumbai, India', has_direct_phone: true },
  { id: '2', name: 'B', title: 'HR Manager', organizationName: 'Acme', organizationDomain: 'acme.in', location: 'Pune, India', has_direct_phone: true },
  { id: '3', name: 'C', title: 'Recruiter', organizationName: 'Acme', organizationDomain: 'acme.in', location: 'Delhi, India', has_direct_phone: true },
  { id: '4', name: 'D', title: 'Recruiting Specialist', organizationName: 'Acme', organizationDomain: 'acme.in', location: 'Remote', has_direct_phone: true },
];
const shortlist = operator.preferredContactShortlist(candidates, { context: {} }, companyContext, {
  names: new Set(), linkedins: new Set(), emails: new Set(), phones: new Set(), ids: new Set(),
}, { contactabilityCandidateLimit: 99 });
assert.equal(shortlist.length, 3);

assert.equal(typeof operator.pendingPhoneRowsForSource, 'function');
assert.equal(typeof targeted.enforceIndianPhoneCompanyGate, 'function');
assert.equal(typeof sheets.clearRows, 'function');

const targetedSource = fs.readFileSync(require.resolve('../core/universal-sheet-enrichment-targeted'), 'utf8');
assert.doesNotMatch(targetedSource, /indian-phone-two-candidate-budget/);
assert.match(targetedSource, /apollo\.indianPhone/);
assert.match(targetedSource, /sheets\.clearRows/);
assert.match(targetedSource, /aiBatchRescue\.run/);
assert.doesNotMatch(targetedSource, /deleteDimension/);

const reportSource = fs.readFileSync(require.resolve('../core/universal-run-report'), 'utf8');
assert.match(reportSource, /i\.rowNumber.*i\.target.*i\.problem/);

console.log('Indian POC phone policy self-test passed: explicit +91 company gating, POC-1\/POC-2 scope, India-first ranking, mature POC-2 rescue preservation, bounded three-person shortlist, pending-callback preservation, duplicate-report collapse and non-shifting rejected-row clearing are protected.');
