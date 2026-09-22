'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const parser = require('../core/universal-linkedin-profile-parser');
const planner = require('../core/universal-enrichment-planner');
const operator = require('../core/universal-sheet-enrichment-operator');

const rawProfile = {
  url: 'https://www.linkedin.com/in/example/',
  sections: {
    main_profile: 'Example Person\nPrincipal Workforce Partner at Northstar Technologies\nIndia',
    experience: [
      'Principal Workforce Partner\nNorthstar Technologies Pvt. Ltd. · Full-time\nJan 2025 - Present',
      'Recruitment Consultant\nOld Company Ltd\n2022 - Dec 2024',
    ],
  },
};
const resolved = parser.resolveCurrentEmployer(rawProfile);
assert.equal(resolved.resolved, true);
assert.match(resolved.company, /Northstar Technologies/i);
assert.doesNotMatch(resolved.company, /Old Company/i);
assert.ok(parser.companyMatchesEvidence('Northstar Technologies Private Limited', parser.evidenceFrom(rawProfile)), 'legal suffix variation should not break evidence anchoring');

const historicalOnly = {
  sections: {
    main_profile: 'Former recruiter and independent advisor',
    experience: ['Recruiter\nOld Company Ltd\nJan 2020 - Dec 2024'],
  },
};
assert.equal(parser.resolveCurrentEmployer(historicalOnly).resolved, false, 'past employment must never be promoted to current');

const companyAnchor = operator.companyFromCompanyAnchor({
  snapshot: { values: { name: 'Acme Systems', linkedin: 'https://www.linkedin.com/company/acme-systems/' } },
});
assert.equal(companyAnchor.company, 'Acme Systems');
assert.equal(companyAnchor.source, 'sheet-company-linkedin');

const existing = { names: new Set(['person one']), linkedins: new Set(['person-one']) };
assert.equal(operator.candidateAlreadyPresent({ name: 'Person One' }, existing), true);
assert.equal(operator.candidateAlreadyPresent({ name: 'Different Person', linkedinUrl: 'https://www.linkedin.com/in/person-one/' }, existing), true);
assert.equal(operator.candidateAlreadyPresent({ name: 'Fresh Person', linkedinUrl: 'https://www.linkedin.com/in/fresh-person/' }, existing), false);

// POC fallback must not require role diversity. If there is no founder/director,
// two distinct verified same-company recruiting/HR people remain valid candidates
// for POC-1 and POC-2.
const hrFallbackCandidates = operator.manualPriorityCandidates([
  {
    id: 'hr-1',
    name: 'Recruiter One',
    title: 'Technical Recruiter',
    organizationName: 'Acme Systems',
    organizationDomain: 'acme.com',
    linkedinUrl: 'https://www.linkedin.com/in/recruiter-one/',
  },
  {
    id: 'hr-2',
    name: 'Recruiter Two',
    title: 'Technical Recruiter',
    organizationName: 'Acme Systems',
    organizationDomain: 'acme.com',
    linkedinUrl: 'https://www.linkedin.com/in/recruiter-two/',
  },
], {
  company: 'Acme Systems',
  domain: 'acme.com',
}, { names: new Set(), linkedins: new Set(), emails: new Set(), phones: new Set(), ids: new Set() });

assert.equal(hrFallbackCandidates.length, 2, 'two distinct same-company recruiters must both stay eligible');
assert.notEqual(hrFallbackCandidates[0].id, hrFallbackCandidates[1].id, 'POC slots must remain distinct people');
assert.ok(hrFallbackCandidates.every((person) => /technical recruiter/i.test(person.title)));

// Role/relevance builds one company-level shortlist first. Contactability is
// enforced only inside that shortlist so provider spend is bounded.
const contactabilityCandidates = [
  {
    id: 'founder-no-phone',
    name: 'Founder Without Phone',
    title: 'Founder',
    hasDirectPhone: 'No',
    organizationName: 'Acme Systems',
    organizationDomain: 'acme.com',
    linkedinUrl: 'https://www.linkedin.com/in/founder-no-phone/',
  },
  {
    id: 'hr-india-no-email',
    name: 'India HR',
    title: 'Human Resources Manager',
    hasDirectPhone: 'Yes',
    organizationName: 'Acme Systems',
    organizationDomain: 'acme.com',
    linkedinUrl: 'https://www.linkedin.com/in/india-hr/',
  },
  {
    id: 'recruiter-foreign-email',
    name: 'Foreign Recruiter',
    title: 'Technical Recruiter',
    hasDirectPhone: 'Yes',
    organizationName: 'Acme Systems',
    organizationDomain: 'acme.com',
    linkedinUrl: 'https://www.linkedin.com/in/foreign-recruiter/',
  },
  {
    id: 'fourth-perfect-but-forbidden',
    name: 'Fourth Candidate',
    title: 'Technical Recruiter',
    hasDirectPhone: 'Yes',
    organizationName: 'Acme Systems',
    organizationDomain: 'acme.com',
    linkedinUrl: 'https://www.linkedin.com/in/fourth-candidate/',
  },
];

const roleOrdered = operator.manualPriorityCandidates(
  contactabilityCandidates,
  { company: 'Acme Systems', domain: 'acme.com' },
  { names: new Set(), linkedins: new Set(), emails: new Set(), phones: new Set(), ids: new Set() },
);
assert.equal(roleOrdered[0].id, 'founder-no-phone', 'role authority must define preferred POC order before contact checks');

const shortlist = operator.preferredContactShortlist(
  contactabilityCandidates,
  { context: {} },
  { company: 'Acme Systems', domain: 'acme.com' },
  { names: new Set(), linkedins: new Set(), emails: new Set(), phones: new Set(), ids: new Set() },
  { contactabilityCandidateLimit: 3 },
);
assert.equal(shortlist.length, 3, 'contactability review must never exceed three preferred people');
assert.equal(shortlist.some((person) => person.id === 'fourth-perfect-but-forbidden'), false, 'fourth candidate must never enter the contactability budget');

assert.equal(operator.contactabilityTier({ phone: '+91 98765 43210', email: 'hr@acme.com' }), 4);
assert.equal(operator.contactabilityTier({ phone: '+91 98765 43210' }), 3);
assert.equal(operator.contactabilityTier({ phone: '+1 415 555 0100', email: 'hr@acme.com' }), 2);
assert.equal(operator.contactabilityTier({ phone: '+1 415 555 0100' }), 1);
assert.equal(operator.contactabilityTier({ email: 'hr@acme.com' }), 0, 'email alone cannot satisfy compulsory phone contactability');

const indiaWins = operator.chooseContactabilityCandidate([
  { person: { name: 'Founder', title: 'Founder' }, tier: 0, index: 0 },
  { person: { name: 'India HR', phone: '+919876543210' }, tier: 3, index: 1 },
  { person: { name: 'Foreign Recruiter', phone: '+14155550100', email: 'r@acme.com' }, tier: 2, index: 2 },
]);
assert.equal(indiaWins.person.name, 'India HR', '+91 phone must beat a foreign phone even when the foreign candidate has email');

const emailBreaksIndiaTie = operator.chooseContactabilityCandidate([
  { person: { name: 'India No Email', phone: '+919876543210' }, tier: 3, index: 0 },
  { person: { name: 'India With Email', phone: '+919812345678', email: 'hr@acme.com' }, tier: 4, index: 1 },
]);
assert.equal(emailBreaksIndiaTie.person.name, 'India With Email', 'email should strongly decide between otherwise valid +91 candidates');

const noPhoneSelection = operator.chooseContactabilityCandidate([
  { person: { name: 'First Preferred' }, tier: 0, index: 0 },
  { person: { name: 'Second Preferred', email: 'second@acme.com' }, tier: 0, index: 1 },
  { person: { name: 'Third Preferred' }, tier: 0, index: 2 },
]);
assert.equal(noPhoneSelection, null, 'empty POC selection must reject all candidates when none has an actual usable phone');

// Existing non-anchor POCs are replaceable when their phone is unusable.
// Replacement must be atomic: stale email/LinkedIn values from the old person
// are overwritten or cleared together with the identity.
const replacementGroup = {
  id: 'person-1',
  kind: 'person',
  ordinal: 1,
  fields: {
    name: { index: 0, header: '1st POC NAME' },
    phone: { index: 1, header: 'PHONE' },
    email: { index: 2, header: 'EMAIL' },
    linkedin: { index: 3, header: 'LINKEDIN' },
  },
};
const replacementRow = [
  'Old Person — Founder',
  '',
  'old.person@acme.com',
  'https://www.linkedin.com/in/old-person/',
];
const replacementPlan = planner.replacementWritesForGroup(
  replacementRow,
  replacementGroup,
  {
    name: 'New Recruiter',
    title: 'Human Resources Manager',
    phone: '+91 98765 43210',
    email: '',
    linkedinUrl: 'https://www.linkedin.com/in/new-recruiter/',
  },
  { reason: 'missing-phone-contactability' },
);
assert.equal(replacementPlan.allowed, true);
const replacementByField = Object.fromEntries(replacementPlan.writes.map((write) => [write.field, write]));
assert.match(replacementByField.name.value, /New Recruiter/);
assert.equal(replacementByField.phone.value, '+91 98765 43210');
assert.equal(replacementByField.email.value, '', 'old person email must be cleared when replacement has no verified email');
assert.equal(replacementByField.linkedin.value, 'https://www.linkedin.com/in/new-recruiter/');
assert.equal(replacementByField.name.allowReplace, true);
assert.equal(replacementByField.email.allowReplace, true);
assert.equal(replacementByField.email.replaces, 'old.person@acme.com');

const protectedPhonePlan = planner.replacementWritesForGroup(
  ['Old Person', '+91 99999 99999', 'old@acme.com', 'https://www.linkedin.com/in/old-person/'],
  replacementGroup,
  {
    name: 'New Recruiter',
    title: 'Technical Recruiter',
    phone: '+91 98888 88888',
    email: 'new@acme.com',
    linkedinUrl: 'https://www.linkedin.com/in/new-recruiter/',
  },
  { reason: 'missing-phone-contactability' },
);
assert.equal(protectedPhonePlan.allowed, false);
assert.ok(protectedPhonePlan.conflicts.includes('existing-phone-protected'));

// Brand-new POC groups with a phone destination must never receive identity-only
// writes. This planner-level rule protects every execution path, not just the
// manual top-3 selector.
const emptyPocGroup = {
  id: 'empty-person-1',
  kind: 'person',
  ordinal: 1,
  fields: {
    name: { index: 0, header: '1st POC NAME' },
    phone: { index: 1, header: 'PHONE' },
    email: { index: 2, header: 'EMAIL' },
  },
};
const noPhoneNewPoc = planner.safeWritesForGroup(
  ['', '', ''],
  emptyPocGroup,
  {
    name: 'Uncontactable Recruiter',
    title: 'Technical Recruiter',
    email: 'recruiter@acme.com',
  },
);
assert.equal(noPhoneNewPoc.allowed, false);
assert.ok(noPhoneNewPoc.conflicts.includes('new-poc-requires-phone'));

const phoneNewPoc = planner.safeWritesForGroup(
  ['', '', ''],
  emptyPocGroup,
  {
    name: 'Contactable Recruiter',
    title: 'Technical Recruiter',
    phone: '+91 98765 43210',
    email: 'recruiter@acme.com',
  },
);
assert.equal(phoneNewPoc.allowed, true);
assert.ok(phoneNewPoc.writes.some((write) => write.field === 'phone' && write.value === '+91 98765 43210'));

assert.equal(planner.samePerson(
  { name: 'Rajeev Ranjan — Recruitment Manager' },
  { name: 'Rajeev Ranjan', title: 'Recruitment Manager' },
), true, 'designation-formatted existing names must preserve identity');

for (const file of [
  'universal-sheet-schema.js',
  'universal-authority-ranker.js',
  'universal-enrichment-planner.js',
  'universal-enrichment-engine.js',
  'universal-linkedin-profile-parser.js',
  'universal-sheet-enrichment-operator.js',
]) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'core', file), 'utf8');
  assert.doesNotMatch(source, /model-router|chatOmniRouteOnly|openai|gemini|anthropic/i, `${file} must not depend on AI/model routing`);
}

const operatorSource = fs.readFileSync(path.join(__dirname, '..', 'core', 'universal-sheet-enrichment-operator.js'), 'utf8');
const liveGuardSource = fs.readFileSync(path.join(__dirname, '..', 'core', 'universal-live-write-guard.js'), 'utf8');
assert.match(operatorSource, /apollo\.searchCompanyPeopleBroad/);
assert.match(operatorSource, /ranker\.rankCandidates/);
assert.match(operatorSource, /apollo\.resolveDecisionMaker/);
assert.match(operatorSource, /profileParser\.resolveCurrentEmployer/);
assert.match(operatorSource, /APOLLO_APPROVAL_REQUIRED/);
assert.match(operatorSource, /modelCalls:\s*0/);
assert.match(
  operatorSource,
  /ULTRON_M3_UNIVERSAL_PRIMARY_POC1_HYDRATION_ATTEMPTS \|\| 3/,
  'POC-1 fast sweep must try multiple verified candidates before leaving the slot unresolved',
);
assert.match(operatorSource, /contactabilityCandidateLimit:\s*3/);
assert.match(operatorSource, /top3-contactability/);
assert.match(operatorSource, /empty-poc-left-blank-no-phone/);
assert.doesNotMatch(operatorSource, /top3-first-preferred-fallback/);
assert.match(operatorSource, /selectContactableReplacement/);
assert.match(operatorSource, /slice\(0, 2\)/, 'existing POC plus at most two replacement candidates must preserve the three-person budget');
assert.match(operatorSource, /replaced-no-phone-poc/);
assert.match(liveGuardSource, /missing-phone-contactability/);
assert.match(liveGuardSource, /change\.allowReplace === true/);

console.log('Universal enrichment operator self-test passed: empty POC slots require an actual phone, contactable replacements are atomic and bounded, populated phones stay protected, arbitrary schema execution uses Apollo only after approval, and the full decision path has zero AI/model dependencies.');
