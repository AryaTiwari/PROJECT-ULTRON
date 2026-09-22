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

// Contactability is now a first-class preference. A verified same-company HR
// candidate with Apollo's direct-phone signal should outrank a higher-title
// candidate with no phone signal, but no candidate is rejected solely for lacking
// a phone.
const phonePreferredCandidates = operator.manualPriorityCandidates([
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
    id: 'hr-with-phone',
    name: 'HR With Phone',
    title: 'Human Resources Manager',
    hasDirectPhone: 'Yes',
    directPhoneAvailability: 2,
    organizationName: 'Acme Systems',
    organizationDomain: 'acme.com',
    linkedinUrl: 'https://www.linkedin.com/in/hr-with-phone/',
  },
], {
  company: 'Acme Systems',
  domain: 'acme.com',
}, { names: new Set(), linkedins: new Set(), emails: new Set(), phones: new Set(), ids: new Set() });

assert.equal(phonePreferredCandidates.length, 2);
assert.equal(phonePreferredCandidates[0].id, 'hr-with-phone', 'phone-available POC should be attempted first');
assert.equal(phonePreferredCandidates[1].id, 'founder-no-phone', 'no-phone candidate must remain a valid fallback');

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

console.log('Universal enrichment operator self-test passed: exact-profile employer parsing is deterministic, existing identity is preserved, arbitrary schema execution uses Apollo only after approval, and the full decision path has zero AI/model dependencies.');
