'use strict';

const assert = require('node:assert/strict');
const control = require('../core/command-control-plane');
const intent = require('../core/apollo-lead-intent-compiler');
const discovery = require('../core/apollo-company-discovery');
const projector = require('../core/apollo-lead-sheet-projector');
const controller = require('../core/apollo-lead-domain-controller');
const contract = require('../core/apollo-lead-contract');

function fakeCompany(i) {
  return {
    id: `benchmark-company-${i}`,
    name: `Benchmark Product Tech ${i}`,
    estimated_num_employees: 35 + (i % 180),
    linkedin_url: `https://www.linkedin.com/company/benchmark-product-tech-${i}`,
    website_url: `https://benchmark-product-tech-${i}.example.com`,
    short_description: 'Technology software product platform company building B2B digital products.',
    industry: 'Software Development',
    keywords: ['technology', 'software', 'product', 'platform'],
    country: 'India',
  };
}

(async () => {
  const query = 'Find me 25 tech product companies. Fill this Google Sheet: @24-sept, worksheet "Arya". Discovery only.';
  const sheetUrl = 'https://docs.google.com/spreadsheets/d/benchmark-sheet-id/edit';

  const route = control.claim(query, {
    attachments: [{
      id: 'benchmark-sheet',
      name: '24-sept.xlsx',
      source: 'google_drive',
      metadata: { spreadsheetUrl: sheetUrl },
    }],
  });
  assert.equal(route.domain, 'apollo-lead');
  assert.equal(route.exclusive, true);
  assert.equal(route.controller, 'apollo-lead-domain-controller');

  const compiled = intent.compile(query, {
    attachments: [{
      id: 'benchmark-sheet',
      name: '24-sept.xlsx',
      source: 'google_drive',
      metadata: { spreadsheetUrl: sheetUrl },
    }],
  });

  assert.equal(compiled.missionType, 'apollo_company_discovery');
  assert.equal(compiled.targetCount, 25);
  assert.equal(compiled.enrichmentRequested, false);
  assert.equal(compiled.sheet.requested, true);
  assert.equal(compiled.sheet.url, sheetUrl);
  assert.equal(compiled.sheet.alias, '24-sept');
  assert.equal(compiled.sheet.sheetName, 'Arya');
  assert.deepEqual(
    {
      min: compiled.employeeRange.min,
      max: compiled.employeeRange.max,
      preferredMin: compiled.employeeRange.preferredMin,
      preferredMax: compiled.employeeRange.preferredMax,
      hard: compiled.employeeRange.hard,
    },
    { min: 10, max: 500, preferredMin: 20, preferredMax: 300, hard: false },
  );

  const summary = controller.summary({
    missionId: 'benchmark',
    missionType: compiled.missionType,
    targetCount: compiled.targetCount,
    compiledFilters: compiled,
  });
  assert.match(summary, /SMB preferred 20-300 employees/);
  assert.doesNotMatch(summary, /size 0-1000/i);

  const attempted = [];
  const discovered = await discovery.discover(compiled, {
    maxSearchCalls: 5,
    fetchPage: async (_mission, _page, _perPage, variant) => {
      attempted.push(variant.id);
      if (variant.id === 'combined-keywords') return { items: [] };
      if (variant.id === 'keyword:product') {
        return { items: Array.from({ length: 35 }, (_, i) => fakeCompany(i + 1)) };
      }
      return { items: [] };
    },
  });

  assert.ok(discovered.organizations.length >= 25);
  assert.equal(new Set(discovered.organizations.map((item) => item.key)).size, discovered.organizations.length);
  const selected = discovered.organizations.slice(0, compiled.targetCount);
  assert.deepEqual(attempted.slice(0, 2), ['combined-keywords', 'keyword:product']);
  assert.ok(discovered.apolloCalls >= 2 && discovered.apolloCalls <= 5);
  assert.ok(discovered.searchVariantsTried >= 2);

  const info = {
    headers: ['COMPANY NAME', 'COMPANY LINK', '1st  POC NAME', 'PHONE', 'EMAIL', '2ND POC NAME', 'PHONE', 'EMAIL', 'Outcome'],
    schema: { companyGroups: [], personGroups: [] },
  };
  const columns = projector.schemaColumns(info);
  assert.equal(columns.companyName, 0);
  assert.equal(columns.companyLink, 1);
  assert.equal(columns.personGroups.length, 0);

  let plannedCells = 0;
  for (const company of selected) {
    const values = projector.rowValues(company, columns, false);
    assert.deepEqual([...values.keys()].sort((a, b) => a - b), [0, 1]);
    assert.equal(values.get(0), company.name);
    assert.ok(String(values.get(1) || '').includes('linkedin.com/company/'));
    plannedCells += values.size;
  }
  assert.equal(plannedCells, 50);

  assert.equal(intent.isApolloLeadControlRequest('Apollo lead progress'), true);
  assert.equal(intent.isApolloLeadControlRequest('Apollo lead status'), true);
  assert.equal(intent.isApolloLeadControlRequest('Apollo lead doctor'), true);

  const progressRoute = control.claim('Apollo lead progress');
  assert.equal(progressRoute.domain, 'apollo-lead');
  assert.equal(progressRoute.controller, 'apollo-lead-domain-controller');
  assert.equal(progressRoute.generalModelAllowed, false);

  const dispatched = await control.dispatch('Apollo lead progress');
  assert.equal(dispatched.route, 'apollo-lead');
  assert.equal(dispatched.model, 'apollo-lead-intelligence');
  assert.equal(dispatched.provider, 'apollo');
  assert.notEqual(dispatched.model, 'linkedin-account-operator');
  assert.ok(dispatched.response.includes(contract.VERSION));

  const stamped = controller.response(true, 'benchmark-ok');
  assert.equal(stamped.apolloLeadContractVersion, contract.VERSION);
  assert.equal(stamped.runtimeBuildId, contract.runtimeBuild.id);
  assert.match(stamped.response, /build /);

  const unresolved = intent.compile(
    'Find me 25 tech product companies. Fill this Google Sheet: @__apollo_benchmark_unbound_20260924__, worksheet "Arya". Discovery only.',
    { attachments: [] },
  );
  assert.equal(unresolved.sheet.requested, true);
  assert.equal(unresolved.sheet.url, '');
  await assert.rejects(
    () => controller.preflightDestination(unresolved),
    (error) => error?.code === 'APOLLO_LEAD_SHEET_SOURCE_UNRESOLVED',
  );

  console.log(JSON.stringify({
    ok: true,
    benchmark: contract.VERSION,
    build: contract.runtimeBuild.id,
    route: route.domain,
    target: compiled.targetCount,
    candidatesInspected: discovered.candidatesFound,
    discovered: selected.length,
    apolloSearchCalls: discovered.apolloCalls,
    searchVariants: discovered.searchVariantsTried,
    plannedRows: selected.length,
    plannedCells,
    contactReveals: 0,
    progressOwner: dispatched.route,
    progressModel: dispatched.model,
    sheetColumns: { companyName: columns.companyName, companyLink: columns.companyLink },
  }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
