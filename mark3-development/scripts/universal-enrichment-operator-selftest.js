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

console.log('Universal enrichment operator self-test passed: exact-profile employer parsing is deterministic, existing identity is preserved, arbitrary schema execution uses Apollo only after approval, and the full decision path has zero AI/model dependencies.');
