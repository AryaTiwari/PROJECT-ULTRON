'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const intent = require('../core/apollo-lead-intent-compiler');
const discovery = require('../core/apollo-company-discovery');
const queryProvider = require('../core/apollo-company-query-provider');
const projector = require('../core/apollo-lead-sheet-projector');

function company(i, overrides = {}) {
  return {
    id: `org-${i}`,
    name: `India SaaS Product ${i}`,
    estimated_num_employees: 25 + i,
    short_description: 'B2B SaaS enterprise cloud software product platform',
    country: 'India',
    linkedin_url: `https://www.linkedin.com/company/india-saas-${i}`,
    website_url: `https://india-saas-${i}.example`,
    ...overrides,
  };
}

(async () => {
  const compiled = intent.compile('Find 25 SaaS product companies in India with 25+ employees. Discovery only.');
  assert.equal(compiled.missionType, 'apollo_company_discovery');
  assert.equal(compiled.enrichmentRequested, false);
  assert.equal(compiled.employeeRange.min, 25);
  assert.equal(compiled.employeeRange.max, null, '25+ must not gain a hidden upper bound');
  for (const concept of ['saas','software as a service','software product','b2b software','enterprise software','cloud software','software platform','product software']) {
    assert.ok(compiled.expandedKeywords.includes(concept), `missing concept ${concept}`);
  }

  const mixed = intent.compile('Find 25 SaaS product companies in India and enrich both POCs.');
  assert.equal(mixed.missionType, 'apollo_company_discovery');
  assert.equal(mixed.enrichmentRequested, false);
  assert.equal(mixed.contactEnrichmentDeferred, true);

  const variants = queryProvider.compile(compiled);
  assert.ok(variants.length >= 4);
  assert.ok(variants.some((variant) => variant.keywords.includes('saas')));
  assert.ok(variants.some((variant) => variant.keywords.includes('software product')));
  const providerDecision = queryProvider.baseline.integrationDecision();
  assert.equal(providerDecision.available, false);
  assert.match(providerDecision.reason, /no supported natural-language company-search API/i);

  let calls = 0;
  const result = await discovery.discover(compiled, {
    fetchPage: async () => {
      calls += 1;
      return { items: Array.from({ length: 100 }, (_, index) => company(index + 1)) };
    },
  });
  assert.equal(result.candidatePoolTarget, 100);
  assert.equal(result.candidatesFound, 100);
  assert.equal(result.organizations.length, 100);
  assert.equal(calls, 1);
  assert.equal(result.organizations.slice(0, compiled.targetCount).length, 25);

  const columns = {
    companyName: 0,
    companyLink: 1,
    personGroups: [{ fields: { name:{ index:2 }, phone:{ index:3 }, email:{ index:4 } } }],
  };
  const record = { ...result.organizations[0], poc1:{ name:'Must Not Write', phone:'+919999999999', email:'x@example.com' } };
  const discoveryValues = projector.rowValues(record, columns, false);
  assert.equal(discoveryValues.has(2), false);
  assert.equal(discoveryValues.has(3), false);
  assert.equal(discoveryValues.has(4), false);
  assert.equal(discoveryValues.get(0), record.name);
  assert.equal(discoveryValues.get(1), record.linkedinUrl);

  const controllerSource = fs.readFileSync(require.resolve('../core/apollo-lead-domain-controller'), 'utf8');
  const missionSource = fs.readFileSync(require.resolve('../core/apollo-lead-mission-store'), 'utf8');
  assert.doesNotMatch(controllerSource, /Companies replaced due to poor contactability/);
  assert.match(controllerSource, /includePeople:\s*false/);
  assert.match(controllerSource, /'Contact reveals: 0'/);
  for (const field of ['spreadsheetId','sheetId','exactWorksheetTitle','candidateCompanies','qualifiedCompanies','peopleSearchCalls','contactRevealCalls','indianPhoneAttempts','foreignFallbacks','unresolvedContactSlots','approvalId','runtimeBuild','completionState']) {
    assert.match(missionSource, new RegExp(field), `mission state missing ${field}`);
  }

  console.log('Apollo final production repair self-test passed: strict split modes, deterministic query compilation, 25+ without hidden cap, 100-company candidate universe, company-only writes, official API decision, zero reveals and complete persisted mission fields are protected.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
