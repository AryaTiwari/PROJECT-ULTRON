'use strict';

const assert = require('assert');
const fs = require('fs');
const controller = require('../core/universal-spreadsheet-domain-controller');
const operator = require('../core/universal-sheet-enrichment-operator');
const apollo = require('../core/apollo-enrichment');
const targeted = require('../core/universal-sheet-enrichment-targeted');
const sheets = require('../core/google-sheets-operator');

assert.equal(controller.parseIndianPhonePolicy('Require Indian phone numbers (+91). Reject companies without one.'), true);
assert.equal(controller.parseIndianPhonePolicy('Only accept India mobile numbers and remove foreign-only companies.'), true);
assert.equal(controller.parseIndianPhonePolicy('Enrich phone and email columns.'), false);
assert.equal(controller.parseExpectedPersonGroups('Use POC-1 and POC-2 only.'), 2);
assert.equal(controller.parseExpectedPersonGroups('Enrich with 1st and 2nd POC.'), 2);
const previousExpectedGroups = process.env.ULTRON_M3_UNIVERSAL_EXPECTED_PERSON_GROUPS;
process.env.ULTRON_M3_UNIVERSAL_EXPECTED_PERSON_GROUPS = '3';
assert.equal(controller.parseExpectedPersonGroups('Enrich with 1st and 2nd POC.'), 2);
if (previousExpectedGroups == null) delete process.env.ULTRON_M3_UNIVERSAL_EXPECTED_PERSON_GROUPS;
else process.env.ULTRON_M3_UNIVERSAL_EXPECTED_PERSON_GROUPS = previousExpectedGroups;
assert.equal(controller.parseAutomaticTwoPocIndianPolicy('Enrich with 1st and 2nd POC.'), true);
assert.equal(controller.parseAutomaticTwoPocIndianPolicy('Enrich POC-1 and POC-2.'), true);
assert.equal(controller.parseAutomaticTwoPocIndianPolicy('Enrich two POCs.'), true);
assert.equal(controller.parseAutomaticTwoPocIndianPolicy('Enrich POC-2 only.'), false);
assert.equal(controller.parseAutomaticTwoPocIndianPolicy('Enrich POC-1, POC-2 and POC-3.'), false);
const automaticSummary = controller.approvalSummary({
  sheetName: 'Leads',
  schema: { personGroups: [{}, {}], companyGroups: [], headerRowNumber: 1 },
  analysis: { stats: { openPersonSlots: 2, partialPersonSlots: 0 } },
}, { requireIndianPhone: true, indianPhonePolicySource: 'automatic-poc1-poc2-default' });
assert.match(automaticSummary, /Indian-number preference \(automatic POC-1\/POC-2 default\)/);
assert.match(automaticSummary, /existing company row is always preserved/);

assert.equal(operator.contactabilityTier({ phone: '+1 415 555 0123', email: 'hr@example.com' }), 2);
assert.equal(operator.contactabilityTier({ phone: '+91 98765 43210' }), 3);
assert.equal(operator.contactabilityTier({ phone: '+91 98765 43210', email: 'hr@example.in' }), 4);
assert.ok(operator.candidateIndiaPriority({ location: 'Mumbai, Maharashtra, India' }) > operator.candidateIndiaPriority({ location: 'New York, USA' }));
const indianPhoneSelection = operator.chooseContactabilityCandidate([
  { person: { name: 'International Founder', title: 'Founder', phone: '+1 212 555 0101', email: '' }, index: 0 },
  { person: { name: 'Indian Recruiter', title: 'Recruiter', phone: '+91 98765 43210', email: '' }, index: 1 },
]);
assert.equal(indianPhoneSelection.person.name, 'Indian Recruiter');

const internationalFallbackSelection = operator.chooseContactabilityCandidate([
  { person: { name: 'Top International Founder', title: 'Founder', phone: '+1 212 555 0101', email: '' }, index: 4 },
  { person: { name: 'Indian Recruiter Without India Phone', title: 'Recruiter', phone: '+44 20 7946 0958', email: 'recruiter@example.com' }, index: 0 },
]);
assert.equal(internationalFallbackSelection.person.name, 'Top International Founder');

const indianAssociateBeatsForeignHead = operator.chooseContactabilityCandidate([
  { person: { name: 'Head Talent International', title: 'Head of Talent Acquisition', phone: '+44 20 7946 0958', email: 'head@example.com' }, index: 0 },
  { person: { name: 'TA Associate India', title: 'Talent Acquisition Associate', phone: '+91 98765 43210', email: '' }, index: 1 },
]);
assert.equal(indianAssociateBeatsForeignHead.person.name, 'TA Associate India');

assert.equal(
  apollo.decisionPriority('Head of Talent Acquisition'),
  2,
  'Head of Talent Acquisition must remain the higher-authority international fallback tier.',
);
assert.equal(
  apollo.decisionPriority('Talent Acquisition Associate'),
  4,
  'Talent Acquisition Associate must remain eligible as a lower-level India-first contact.',
);
assert.equal(operator.indiaPhoneFirstEnabled({ requireIndianPhone: true }), true);
assert.equal(operator.indiaPhoneFirstEnabled({ requireIndianPhone: false }), false);
assert.ok(
  operator.indiaFirstDecisionMakerTitles().some((title) => /talent acquisition associate/i.test(title)),
  'India-first Apollo search must include Talent Acquisition Associate.',
);

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
assert.equal(operator.phoneQualifiedCandidateLimit({}), 8);
assert.equal(operator.phoneQualifiedCandidateLimit({ contactabilityCandidateLimit: 99 }), 10);
assert.equal(shortlist.length, 4);

const foreignHeavyCandidates = Array.from({ length: 10 }, (_, index) => ({
  id: 'foreign-' + index,
  name: 'Foreign ' + index,
  title: index === 0 ? 'Head of Talent Acquisition' : 'Recruiter',
  organizationName: 'Acme',
  organizationDomain: 'acme.in',
  location: 'New York, USA',
  has_direct_phone: true,
}));
foreignHeavyCandidates.splice(5, 0, {
  id: 'india-ta-associate',
  name: 'India TA Associate',
  title: 'Talent Acquisition Associate',
  organizationName: 'Acme',
  organizationDomain: 'acme.in',
  location: 'Mumbai, India',
});
const strictIndiaShortlist = operator.preferredContactShortlist(
  foreignHeavyCandidates,
  { context: {} },
  companyContext,
  { names: new Set(), linkedins: new Set(), emails: new Set(), phones: new Set(), ids: new Set() },
  { requireIndianPhone: true, contactabilityCandidateLimit: 8 },
);
assert.equal(
  strictIndiaShortlist[0].name,
  'India TA Associate',
  'A lower-level India-aware candidate must reach hydration before foreign-phone leaders.',
);

const operatorSource = fs.readFileSync(require.resolve('../core/universal-sheet-enrichment-operator'), 'utf8');
assert.match(operatorSource, /indiaPrioritySearches/);
assert.match(operatorSource, /indiaFirstSearch:\s*true/);
assert.match(operatorSource, /location:\s*text\(options\.location\) \|\| 'India'/);
assert.match(operatorSource, /indiaFirst && options\.resultsFirstSweep/);
assert.match(operatorSource, /!indiaFirst \|\| hasIndianPhoneSignal\(cached\)/);

assert.equal(typeof operator.pendingPhoneRowsForSource, 'function');
assert.equal(typeof targeted.enforceIndianPhoneCompanyGate, 'function');
assert.equal(typeof sheets.clearRows, 'function');

const targetedSource = fs.readFileSync(require.resolve('../core/universal-sheet-enrichment-targeted'), 'utf8');
assert.doesNotMatch(targetedSource, /indian-phone-two-candidate-budget/);
assert.match(targetedSource, /apollo\.indianPhone/);
assert.doesNotMatch(targetedSource, /sheets\.clearRows\s*\(/);
assert.match(targetedSource, /companyRowDeletionAllowed:\s*false/);
assert.match(targetedSource, /preservedCompanyRows/);
assert.match(targetedSource, /aiBatchRescue\.run/);
assert.doesNotMatch(targetedSource, /deleteDimension/);

const reportSource = fs.readFileSync(require.resolve('../core/universal-run-report'), 'utf8');
assert.match(reportSource, /i\.rowNumber.*i\.target.*i\.problem/);

console.log('Indian POC phone policy self-test passed: automatic two-POC defaults, hard phone qualification, POC-1/POC-2 scope, India-first ranking, broader bounded decision-maker fallback, pending-callback preservation, and the invariant that contactability failures never clear or remove company rows are protected.');
