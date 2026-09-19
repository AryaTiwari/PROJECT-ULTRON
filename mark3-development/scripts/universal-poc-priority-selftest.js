'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const base = require('../core/universal-sheet-enrichment-operator');
const ranker = require('../core/universal-authority-ranker');
const apollo = require('../core/apollo-enrichment');

const companyContext = { company: 'Example Technologies Pvt Ltd', domain: 'example.com' };
const existing = { names: new Set(['anchor person']), linkedins: new Set() };

const candidates = [
  { id: 'recruiter', name: 'Recruiter One', title: 'Technical Recruiter', organizationName: 'Example Technologies Pvt Ltd', organizationDomain: 'example.com' },
  { id: 'manager', name: 'Manager One', title: 'Talent Acquisition Manager', organizationName: 'Example Technologies Pvt Ltd', organizationDomain: 'example.com' },
  { id: 'director', name: 'Director One', title: 'Director', organizationName: 'Example Technologies Pvt Ltd', organizationDomain: 'example.com' },
  { id: 'engineer', name: 'Engineer One', title: 'Software Engineer', organizationName: 'Example Technologies Pvt Ltd', organizationDomain: 'example.com' },
  { id: 'other-company', name: 'Other Director', title: 'Director', organizationName: 'Wrong Company', organizationDomain: 'wrong.example' },
];

const ordered = base.manualPriorityCandidates(candidates, companyContext, existing);
assert.deepEqual(
  ordered.map((item) => item.id),
  ['director', 'manager', 'recruiter'],
  'manual POC selector must enforce Founder/Director/Owner > recruiting/HR Head/Manager > Recruiter and reject unrelated/wrong-employer people',
);

const hanvitt = base.inferHiringCompanyFromEvidence({
  anchor: { snapshot: { values: { linkedin: 'https://www.linkedin.com/in/example/' } } },
  context: {
    postDetails: 'Founder @ Hanvitt Consulting & Solutions | IT Staffing\nInterested candidates: hello@hanvitt.com',
  },
});
assert.equal(hanvitt?.company, 'Hanvitt Consulting & Solutions');
assert.equal(hanvitt?.source, 'row-headline-employer');

const peopleClick = base.inferHiringCompanyFromEvidence({
  anchor: { snapshot: { values: { linkedin: 'https://www.linkedin.com/in/example/' } } },
  context: {
    postDetails: 'IT Recruiter | Recruitment & Talent Acquisition\nInterested candidates can share at akilandeshwari.s@people-click.com',
  },
});
assert.equal(peopleClick?.company, 'people click');
assert.equal(peopleClick?.domain, 'people-click.com');
assert.equal(peopleClick?.source, 'row-business-email-domain');
assert.equal(ranker.sameEmployer(
  { organizationName: 'People Click Techno Solutions Pvt Ltd', organizationDomain: '' },
  peopleClick,
), true, 'domain-derived brand alias must match the Apollo organization label');

const sutherland = base.inferHiringCompanyFromEvidence({
  anchor: { snapshot: { values: { linkedin: 'https://www.linkedin.com/in/example/' } } },
  context: {
    postDetails: 'Sutherland is looking for an experienced SAP FICO Senior Consultant.\nApply: hr@a3nity.com',
  },
});
assert.equal(sutherland?.company, 'Sutherland', 'explicit hiring-company wording must beat a staffing/application email domain');
assert.equal(sutherland?.source, 'row-company-is-hiring');

const existingPocContext = base.existingPersonVerificationContext({
  snapshot: { values: { name: 'Satish Mandula — Director - Talent Acquisition', email: 'satish@sutherlandglobal.com' } },
}, { company: 'Sutherland', domain: '' });
assert.equal(existingPocContext.domain, 'sutherlandglobal.com');
assert.equal(existingPocContext.source, 'existing-poc-business-email-domain');

const hydratedPeopleClick = {
  id: 'apollo-people-click-1',
  organization_name: 'People Click Techno Solutions Private Limited',
  organization: {},
};
const discoveredPeopleClick = {
  id: 'apollo-people-click-1',
  organizationName: 'People Click Techno Solutions Pvt Ltd',
  organizationDomain: 'people-click.com',
};
assert.equal(
  apollo.hydratedEmployerMatchesCandidate(hydratedPeopleClick, discoveredPeopleClick, 'people click', 'people-click.com'),
  true,
  'same Apollo candidate must survive harmless hydrated employer alias drift',
);
assert.equal(
  apollo.hydratedEmployerMatchesCandidate(
    { id: 'apollo-people-click-1', organization_name: 'Completely Different Staffing', organization: {} },
    discoveredPeopleClick,
    'people click',
    'people-click.com',
  ),
  false,
  'hydration must still reject a clearly different employer',
);

assert.equal(
  apollo.hydratedEmployerMatchesCandidate(
    { id: 'apollo-linkedin-current', organization_name: 'Old Employer', organization: {} },
    {
      id: 'apollo-linkedin-current',
      organizationName: 'Hanvitt Consulting & Solutions',
      organizationDomain: 'hanvitt.com',
      linkedinEmployerVerified: true,
      linkedinEmployerCompany: 'Hanvitt Consulting & Solutions',
    },
    'Hanvitt Consulting & Solutions',
    'hanvitt.com',
  ),
  true,
  'explicit current-employer proof from authenticated LinkedIn may override stale Apollo organization metadata for the exact same identity',
);

assert.equal(base.anchorNeedsHydration({
  anchor: {
    type: 'person',
    group: { fields: { phone: { index: 3 }, email: { index: 4 } } },
    snapshot: { values: { phone: '+919999999999', email: 'ready@example.com' } },
  },
}), false, 'complete POC-1 should not be re-hydrated merely for ceremony');

assert.equal(base.anchorNeedsHydration({
  anchor: {
    type: 'person',
    group: { fields: { phone: { index: 3 }, email: { index: 4 } } },
    snapshot: { values: { phone: '', email: 'ready@example.com' } },
  },
}), true, 'missing POC-1 phone must still trigger exact anchor hydration');

assert.equal(base.companyBrandFromDomain('people-click.com'), 'people click');
const linkedinRefs = [...base.collectLinkedInPersonUrls({
  references: {
    search: [
      { kind: 'person', url: '/in/example-one/' },
      { kind: 'person', url: 'https://www.linkedin.com/in/example-two/' },
    ],
  },
})];
assert.equal(linkedinRefs.length, 2);
assert.ok(linkedinRefs.every((value) => /linkedin\.com\/in\//.test(value)));

const companySlugs = [...base.collectLinkedInCompanySlugs({
  references: {
    search: [
      { kind: 'company', url: '/company/hanvitt-consulting-solutions/' },
      { kind: 'company', url: 'https://www.linkedin.com/company/people-click/' },
    ],
  },
})];
assert.deepEqual(companySlugs, ['hanvitt-consulting-solutions', 'people-click']);

const root = path.join(__dirname, '..', 'core');
const operatorSource = fs.readFileSync(path.join(root, 'universal-sheet-enrichment-operator.js'), 'utf8');
const rescueSource = fs.readFileSync(path.join(root, 'universal-ai-batch-rescue.js'), 'utf8');
const targetedSource = fs.readFileSync(path.join(root, 'universal-sheet-enrichment-targeted.js'), 'utf8');

const anchorCompletionIndex = operatorSource.indexOf('writes.push(...await enrichAnchorGroup');
const unresolvedEmployerGuardIndex = operatorSource.indexOf('if (!companyContext || companyContext.unresolved || !companyContext.company)');
assert.ok(anchorCompletionIndex >= 0, 'POC-1 anchor completion call must exist');
assert.ok(unresolvedEmployerGuardIndex >= 0, 'employer-resolution guard must exist');
assert.ok(anchorCompletionIndex < unresolvedEmployerGuardIndex, 'POC-1 completion must execute before employer gating');
assert.match(operatorSource, /discoverPriorityPeopleFast/);
assert.match(operatorSource, /companyBrandFromDomain/);
assert.match(operatorSource, /adaptiveBroadCandidateLimit/);
assert.match(operatorSource, /APOLLO_ADAPTIVE_BROAD_SEARCH_FAILED/);
assert.match(operatorSource, /APOLLO_BRAND_KEYWORD_SEARCH_FAILED/);
assert.match(operatorSource, /LINKEDIN_ZERO_RESULT_SEARCH_FAILED/);
assert.match(operatorSource, /linkedinMcp\.callTool\('search_companies'/);
assert.match(operatorSource, /linkedinMcp\.callTool\('get_company_employees'/);
assert.match(operatorSource, /linkedinMcp\.callTool\('search_people'/);
assert.match(operatorSource, /profileParser\.resolveCurrentEmployer/);
assert.match(operatorSource, /linkedinEmployerVerified: true/);
assert.match(operatorSource, /apollo\.resolvePersonProfile/);
assert.match(operatorSource, /ULTRON_M3_UNIVERSAL_LINKEDIN_ZERO_RESULT_FALLBACK/);
assert.match(operatorSource, /priority-fast-v2\|/);
assert.match(operatorSource, /fillManualPriorityGroup/);
assert.match(operatorSource, /ordinal: 2/);
assert.match(operatorSource, /maxHydrationAttempts: options\.poc2HydrationAttempts \?\? 3/);
assert.match(operatorSource, /ordinal: 3/);
assert.match(operatorSource, /maxHydrationAttempts: options\.poc3HydrationAttempts \?\? 1/);
assert.match(operatorSource, /priorityCandidateLimit: options\.manualPriorityCandidateLimit \?\? 20/);
assert.doesNotMatch(operatorSource, /candidateLimit: options\.manualCandidateLimit \?\? 40/);
assert.match(operatorSource, /preferredHiringCompanyContext/);
assert.match(operatorSource, /row-business-email-domain/);
assert.match(operatorSource, /existing-poc-business-email-domain/);
assert.match(operatorSource, /anchor-hydration-skipped-complete/);
assert.match(operatorSource, /allowLinkedInEmployerFallback: false/);

const runSource = operatorSource.slice(operatorSource.indexOf('async function run(request = {}, options = {})'));
const exactRepairIndex = runSource.indexOf('repairExistingGroups(row, plan, companyContext, stats, repairOptions)');
const prioritySearchIndex = runSource.indexOf('discoverPriorityPeopleFast(companyContext, cache, stats');
assert.ok(exactRepairIndex >= 0 && prioritySearchIndex > exactRepairIndex, 'existing POC exact repair must happen before candidate discovery');
assert.match(runSource, /if \(poc2Targets\.length && !aiFallbackEnabled\) \{[\s\S]*?discoverPriorityPeopleFast/);
assert.match(runSource, /if \(aiFallbackEnabled\) \{[\s\S]*?stats\.deferredOpenGroups/);
assert.match(runSource, /if \(poc3Targets\.length\) \{[\s\S]*?if \(people\.length\)/);

assert.match(rescueSource, /Number\(item\.group\?\.ordinal \|\| 0\) === wantedOrdinal/);
assert.match(rescueSource, /primaryResult\?\.stats\?\.deferredPoc2Rows/);
assert.match(rescueSource, /no-primary-poc2-residue/);
assert.match(rescueSource, /const wantedOrdinal = 2/);
assert.match(rescueSource, /unresolvedContextInput/);
assert.match(rescueSource, /\? \['groq', 'gemini', 'nvidia'\]/);
assert.match(rescueSource, /ULTRON_M3_UNIVERSAL_AI_REVIEWER \|\| '0'/);

assert.match(targetedSource, /targetOrdinals: \[2\]/);
assert.match(targetedSource, /targetRows: unresolvedRows/);
assert.match(targetedSource, /maxFallbackAttemptsPerTarget: 1/);
assert.doesNotMatch(targetedSource, /targetOrdinals:\s*\[3\]/);

console.log('Universal POC priority self-test passed: existing POCs repair deterministically, empty POC-2 skips redundant manual hydration when batch AI is enabled, sparse-company discovery escalates Apollo -> LinkedIn company employees -> exact profile verification, empty discovery is not cached, LinkedIn current-employer proof can safely override stale Apollo org metadata for the exact identity, and POC-3 remains optional.');
