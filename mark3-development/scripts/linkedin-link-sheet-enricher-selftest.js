'use strict';

const assert = require('assert/strict');
const schema = require('../core/universal-sheet-schema');
const linkEnricher = require('../core/linkedin-link-sheet-enricher');
const commandControl = require('../core/command-control-plane');
const universalSheetController = require('../core/universal-spreadsheet-domain-controller');
const linkedInSheetController = require('../core/linkedin-link-sheet-domain-controller');

function fakeSheets(changes, liveValues = []) {
  return {
    linkedInHyperlinks: async () => new Map(),
    batchValues: async (_id, ranges) => ranges.map((_, index) => [liveValues[index] || '']),
    cellRange: (sheetName, rowNumber, columnIndex) => {
      let n = Number(columnIndex) + 1;
      let column = '';
      while (n > 0) {
        const rem = (n - 1) % 26;
        column = String.fromCharCode(65 + rem) + column;
        n = Math.floor((n - 1) / 26);
      }
      return `'${sheetName.replace(/'/g, "''")}'!${column}${rowNumber}`;
    },
    writeCells: async (_id, items) => {
      changes.push(...items);
      return { updatedCells: items.length };
    },
  };
}

function fakeLinkedIn() {
  const calls = [];
  return {
    calls,
    async callTool(tool, args) {
      calls.push({ tool, args });
      if (tool === 'search_companies') {
        return {
          companies: [{
            name: 'Acme Technologies',
            linkedin_url: 'https://www.linkedin.com/company/acme-technologies/',
          }],
        };
      }
      if (tool === 'get_company_profile') {
        return {
          name: 'Acme Technologies',
          urn: 'urn:li:organization:123',
          company_urn: { kind: 'company_urn', value: '123' },
        };
      }
      if (tool === 'search_people') {
        return {
          people: [{
            name: 'Alice Smith',
            linkedin_url: 'https://www.linkedin.com/in/alice-smith/',
          }, {
            name: 'Wrong Employer',
            linkedin_url: 'https://www.linkedin.com/in/wrong-employer/',
          }],
        };
      }
      if (tool === 'get_person_profile' && String(args.linkedin_username) === 'alice-smith') {
        return {
          name: 'Alice Smith',
          experiences: [{
            organization_name: 'Acme Technologies',
            position_title: 'Talent Acquisition Associate',
            current: true,
          }],
        };
      }
      if (tool === 'get_person_profile') {
        return {
          name: 'Wrong Employer',
          experiences: [{
            organization_name: 'Other Company',
            position_title: 'Recruiter',
            current: true,
          }],
        };
      }
      throw new Error(`Unexpected LinkedIn tool: ${tool}`);
    },
  };
}

async function main() {
  const sheetUrl = 'https://docs.google.com/spreadsheets/d/abc123';

  const exactLinkedInRequest = `ULTRON, run the **isolated LinkedIn-link enrichment pass only** for the \`salesforce/oracle/tech\` worksheet.

## PRESERVATION RULES

- Preserve every existing LinkedIn URL.
- Never overwrite a populated LinkedIn cell.
- Do not modify phone numbers, emails, designations, company names, or any other fields.
- Do not perform Apollo enrichment.
- No Apollo.
- Do not run the normal phone/email/POC enrichment flow.

Google Sheet:
${sheetUrl}

Worksheet: \`salesforce/oracle/tech\``;

  assert.equal(
    commandControl.isLinkedInSheetLinkEnrichmentRequest(exactLinkedInRequest),
    true,
    'Exact isolated LinkedIn-link prompt must stay on the dedicated route even when preservation rules mention phone/email/designation.',
  );
  assert.equal(
    commandControl.claim(exactLinkedInRequest).domain,
    'linkedin-sheet-links',
  );
  assert.equal(
    universalSheetController.parseSheetName(exactLinkedInRequest),
    'salesforce/oracle/tech',
  );

  const exactPocRequest = `ULTRON, enrich only the \`salesforce/oracle/tech\` worksheet in this Google Sheet:
${sheetUrl}

## Scope

Complete **POC-1 and POC-2** with verified:
- Full name
- Current designation
- Work email
- Phone number

Worksheet: \`salesforce/oracle/tech\``;

  assert.equal(
    commandControl.claim(exactPocRequest).domain,
    'spreadsheet-enrichment',
  );
  assert.equal(
    universalSheetController.parseSheetName(exactPocRequest),
    'salesforce/oracle/tech',
  );

  assert.equal(
    commandControl.isLinkedInSheetLinkEnrichmentRequest(
      `Enrich missing company and POC LinkedIn links in ${sheetUrl}`,
    ),
    true,
  );
  assert.equal(
    commandControl.isLinkedInSheetLinkEnrichmentRequest(
      `Enrich POC phone and email data from LinkedIn in ${sheetUrl}`,
    ),
    false,
  );
  assert.equal(
    commandControl.claim(`Enrich missing company and POC LinkedIn links in ${sheetUrl}`).domain,
    'linkedin-sheet-links',
  );

  const rows = [
    ['Company Name', 'Company LinkedIn', 'POC 1 Name', 'POC 1 LinkedIn', 'POC 2 Name', 'POC 2 LinkedIn'],
    ['Acme Technologies', '', 'Alice Smith', '', 'Bob Jones', 'https://www.linkedin.com/in/bob-jones/'],
  ];
  const inferred = schema.inferSchema(rows);
  const companyGroup = inferred.companyGroups[0];
  const poc1 = inferred.personGroups.find((group) => Number(group.ordinal) === 1);
  const poc2 = inferred.personGroups.find((group) => Number(group.ordinal) === 2);
  assert.ok(companyGroup?.fields?.company);
  assert.ok(companyGroup?.fields?.linkedin);
  assert.ok(poc1?.fields?.name);
  assert.ok(poc1?.fields?.linkedin);
  assert.ok(poc2?.fields?.name);
  assert.ok(poc2?.fields?.linkedin);

  const plan = linkEnricher.plan({
    spreadsheetId: 'abc123',
    sheetName: 'salesforce/oracle/tech',
    rows: rows.map((row) => row.slice()),
    schema: inferred,
  });
  assert.equal(plan.activated, true);
  assert.equal(plan.companyTargets, 1);
  assert.equal(plan.personTargets, 1);
  assert.deepEqual(
    plan.targets.map((target) => [target.type, target.rowNumber, target.columnIndex]),
    [['company', 2, 1], ['person', 2, 3]],
  );

  const labeledRows = [
    ['Company Name', 'Company LinkedIn'],
    ['Acme Technologies', 'Open on LinkedIn'],
  ];
  const labeledSchema = schema.inferSchema(labeledRows);
  const labeledPlan = linkEnricher.plan({
    spreadsheetId: 'abc123', sheetName: 'salesforce/oracle/tech',
    rows: labeledRows, schema: labeledSchema,
  });
  assert.equal(labeledPlan.companyTargets, 1, 'A display label without a company URL is a fillable gap.');
  const labeledChanges = [];
  const labeledResult = await linkEnricher.run({
    spreadsheetId: 'abc123', sheetName: 'salesforce/oracle/tech',
    rows: labeledRows.map((row) => row.slice()), schema: labeledSchema,
  }, {
    sheetsApi: fakeSheets(labeledChanges, ['Open on LinkedIn']),
    linkedinMcp: fakeLinkedIn(),
  });
  assert.equal(labeledResult.stats.companyLinksFilled, 1, 'Replace a stale display label with the verified company URL.');
  assert.equal(labeledChanges[0]?.value, 'https://www.linkedin.com/company/acme-technologies/');

  // The real LinkedIn MCP returns company search results through references
  // ({ kind, url, text }) and company profiles without a top-level name.
  const providerShapeChanges = [];
  const providerShapeRows = [['Company Name', 'Company LinkedIn'], ['Acme Technologies', '']];
  const providerShapeProvider = {
    async callTool(tool) {
      if (tool === 'search_companies') {
        return { sections: { search_results: 'Acme Technologies' }, references: {
          search_results: [{ kind: 'company', url: 'https://www.linkedin.com/company/acme-technologies/', text: 'Acme Technologies' }],
        } };
      }
      if (tool === 'get_company_profile') {
        return { url: 'https://www.linkedin.com/company/acme-technologies/', sections: { about: 'Acme Technologies information.' } };
      }
      throw new Error(`Unexpected provider-shape LinkedIn tool: ${tool}`);
    },
  };
  const providerShapeResult = await linkEnricher.run({
    spreadsheetId: 'abc123', sheetName: 'salesforce/oracle/tech',
    rows: providerShapeRows, schema: schema.inferSchema(providerShapeRows),
  }, {
    sheetsApi: fakeSheets(providerShapeChanges),
    linkedinMcp: providerShapeProvider,
  });
  assert.equal(providerShapeResult.stats.companyLinksFilled, 1, 'Verify company identity from real MCP references when profile.name is absent.');
  assert.equal(providerShapeChanges[0]?.value, 'https://www.linkedin.com/company/acme-technologies/');

  const relativeReferenceChanges = [];
  const relativeReferenceResult = await linkEnricher.run({
    spreadsheetId: 'abc123', sheetName: 'salesforce/oracle/tech',
    rows: [['Company Name', 'Company LinkedIn'], ['Pixxel', '']],
    schema: schema.inferSchema([['Company Name', 'Company LinkedIn'], ['Pixxel', '']]),
  }, {
    sheetsApi: fakeSheets(relativeReferenceChanges),
    linkedinMcp: {
      async callTool(tool) {
        assert.equal(tool, 'search_companies');
        return {
          url: 'https://www.linkedin.com/search/results/companies/?keywords=Pixxel',
          sections: { search_results: 'Pixxel' },
          references: { search_results: [
            { kind: 'company', url: '/company/pixxelspace/', text: 'Pixxel', context: 'search result' },
            { kind: 'company', url: '/company/pixxel-technology/', text: 'Pixxel Technology', context: 'search result' },
          ] },
        };
      },
    },
  });
  assert.equal(relativeReferenceResult.stats.companyLinksFilled, 1, 'Convert verified relative LinkedIn references into full LinkedIn profile URLs.');
  assert.equal(relativeReferenceResult.stats.companyProfileFetches, 0);
  assert.equal(relativeReferenceChanges[0]?.value, 'https://www.linkedin.com/company/pixxelspace/');

  const ambiguousProfileCalls = [];
  const ambiguousProfileChanges = [];
  const ambiguousRows = [['Company Name', 'Company LinkedIn'], ['Acme', '']];
  const ambiguousResult = await linkEnricher.run({
    spreadsheetId: 'abc123', sheetName: 'salesforce/oracle/tech',
    rows: ambiguousRows, schema: schema.inferSchema(ambiguousRows),
  }, {
    sheetsApi: fakeSheets(ambiguousProfileChanges),
    linkedinMcp: {
      async callTool(tool, args) {
        ambiguousProfileCalls.push({ tool, args });
        if (tool === 'search_companies') return { references: { search_results: [
          { kind: 'company', url: '/company/acme-one/', text: 'Acme' },
          { kind: 'company', url: '/company/acme-two/', text: 'Acme' },
          { kind: 'company', url: '/company/acme-three/', text: 'Acme Corporation' },
          { kind: 'company', url: '/company/acme-four/', text: 'Acme Holdings' },
        ] } };
        if (tool === 'get_company_profile') return {
          name: 'Acme Labs', url: 'https://www.linkedin.com/company/acme-one/',
        };
        throw new Error(`Unexpected ambiguous LinkedIn tool: ${tool}`);
      },
    },
  });
  assert.equal(ambiguousResult.stats.companyLinksFilled, 0, 'Reject ambiguous exact-name pages when profile identity does not confirm the requested company.');
  assert.equal(ambiguousResult.stats.companyProfileFetches, 1, 'Bound ambiguous company verification to one profile call.');
  assert.equal(ambiguousResult.stats.companyAmbiguousExactSearches, 1);
  assert.equal(ambiguousProfileCalls.filter((call) => call.tool === 'get_company_profile').length, 1);
  assert.equal(ambiguousResult.stats.companyProfileNameMismatches, 1);
  assert.equal(ambiguousProfileChanges.length, 0, 'Do not guess between duplicate exact-name LinkedIn pages.');

  const exactSearchCalls = [];
  const exactSearchChanges = [];
  const markdownCompanyRecord = linkEnricher.collectLinkedInRecords(
    '[Example Holdings](https://www.linkedin.com/company/example-holdings/)',
    'company',
  );
  assert.equal(markdownCompanyRecord[0]?.name, 'Example Holdings', 'Read company identity from Markdown search-result links.');
  const exactCompanyRows = [
    ['Company Name', 'Company LinkedIn'],
    ['Example Holdings Pvt Ltd', ''],
  ];
  const exactCompanyResult = await linkEnricher.run({
    spreadsheetId: 'abc123', sheetName: 'salesforce/oracle/tech',
    rows: exactCompanyRows, schema: schema.inferSchema(exactCompanyRows),
  }, {
    sheetsApi: fakeSheets(exactSearchChanges),
    linkedinMcp: {
      async callTool(tool, args) {
        exactSearchCalls.push({ tool, args });
        assert.equal(tool, 'search_companies');
        const rawText = '[Example Holdings](https://www.linkedin.com/company/example-holdings/)';
        return { rawText, content: [{ type: 'text', text: rawText }] };
      },
    },
  });
  assert.equal(exactCompanyResult.stats.companyLinksFilled, 1, 'A unique exact LinkedIn company-search identity should fill the company URL.');
  assert.equal(exactCompanyResult.stats.companyExactSearchMatches, 1);
  assert.equal(exactCompanyResult.stats.companyProfileFetches, 0, 'Do not spend an extra LinkedIn call hydrating an already exact unique search match.');
  assert.equal(exactSearchCalls.length, 1);
  assert.equal(exactSearchChanges[0]?.value, 'https://www.linkedin.com/company/example-holdings/');

  const cappedCalls = [];
  const cappedRows = [
    ['Company Name', 'Company LinkedIn'],
    ['Company One', ''], ['Company Two', ''], ['Company Three', ''],
  ];
  const cappedResult = await linkEnricher.run({
    spreadsheetId: 'abc123', sheetName: 'salesforce/oracle/tech',
    rows: cappedRows, schema: schema.inferSchema(cappedRows),
  }, {
    sheetsApi: fakeSheets([]),
    linkedinMcp: {
      async callTool(tool, args) {
        cappedCalls.push({ tool, args });
        const error = new Error('LinkedIn hourly safety cap reached (30/30).');
        error.code = 'LINKEDIN_HOURLY_CAP';
        error.cooldownUntil = '2026-10-06T08:15:00.000Z';
        throw error;
      },
    },
  });
  assert.equal(cappedResult.stats.providerStop.code, 'LINKEDIN_HOURLY_CAP');
  assert.equal(cappedResult.stats.providerStop.nextEligibleAt, '2026-10-06T08:15:00.000Z', 'Keep the provider safety window reset time for the user-facing result.');
  assert.equal(cappedCalls.length, 1, 'Stop queued provider calls immediately after a safety cap is reached.');
  assert.equal(cappedResult.stats.linkedinProviderCalls, 1);

  const originalInspect = universalSheetController.inspect;
  const originalRun = linkEnricher.run;
  try {
    universalSheetController.inspect = async () => ({
      spreadsheetId: 'abc123', spreadsheetTitle: 'Test', sheetName: 'salesforce/oracle/tech', sheetId: 1,
      rows: labeledRows.map((row) => row.slice()),
      analysis: { schema: labeledSchema },
    });
    linkEnricher.run = async () => ({
      activated: true,
      stats: {
        companyLinksFilled: 0, personLinksFilled: 0,
        companyUnresolvedRows: [2], personUnresolvedRows: [],
        providerStop: {
          code: 'LINKEDIN_HOURLY_CAP',
          message: 'LinkedIn hourly safety cap reached (30/30). Wait before another account scrape.',
          nextEligibleAt: '2026-10-06T08:15:00.000Z',
        },
      },
      plan: { activated: true, companyTargets: 1, targets: [] },
      writes: { company: 0, person: 0 },
    });
    const partial = await linkedInSheetController.handle(exactLinkedInRequest, { originalMessage: exactLinkedInRequest });
    assert.equal(partial.ok, true, 'A partial result should be returned as an explanation instead of a generic dispatcher error.');
    assert.equal(partial.partial, true);
    assert.equal(partial.errorCode, 'LINKEDIN_LINKS_UNRESOLVED');
    assert.match(partial.response, /1 company row remains unverified/);
    assert.match(partial.response, /hourly safety cap reached/);
    assert.match(partial.response, /rerun the same request/);
    assert.match(partial.response, /next safe retry time is .*ist/i);
  } finally {
    universalSheetController.inspect = originalInspect;
    linkEnricher.run = originalRun;
  }

  const changes = [];
  const linkedin = fakeLinkedIn();
  const result = await linkEnricher.run({
    spreadsheetId: 'abc123',
    sheetName: 'salesforce/oracle/tech',
    rows: rows.map((row) => row.slice()),
    schema: inferred,
  }, {
    sheetsApi: fakeSheets(changes),
    linkedinMcp: linkedin,
  });

  assert.equal(result.ok, true);
  assert.equal(result.stats.companyLinksFilled, 1);
  assert.equal(result.stats.personLinksFilled, 1);
  assert.equal(changes.length, 2);
  // Incremental-write regression: a fast target must be written while another
  // provider lookup is still hanging. The old implementation waited for the
  // complete company phase, making the sheet appear dead for minutes.
  const incrementalChanges = [];
  let releaseSlow = null;
  const slowGate = new Promise((resolve) => { releaseSlow = resolve; });
  const incrementalRows = [
    ['Company Name', 'Company LinkedIn', 'POC 1 Name', 'POC 1 LinkedIn'],
    ['Fast Company', '', '', ''],
    ['Slow Company', '', '', ''],
  ];
  const incrementalSchema = schema.inferSchema(incrementalRows);
  const incrementalProvider = {
    calls: [],
    async callTool(tool, args) {
      this.calls.push({ tool, args });
      const company = String(args?.keywords || '');
      if (tool === 'search_companies') {
        if (company === 'Slow Company') await slowGate;
        return { companies: [{
          name: company,
          linkedin_url: `https://www.linkedin.com/company/${company.toLowerCase().replaceAll(' ', '-')}/`,
        }] };
      }
      if (tool === 'get_company_profile') {
        const slug = String(args?.company_name || '');
        const company = slug.replace(/-/g, ' ');
        return {
          name: company.replace(/\b\w/g, (ch) => ch.toUpperCase()),
          urn: `urn:li:organization:${slug.length}`,
        };
      }
      throw new Error(`Unexpected incremental LinkedIn tool: ${tool}`);
    },
  };
  const incrementalPromise = linkEnricher.run({
    spreadsheetId: 'abc123',
    sheetName: 'salesforce/oracle/tech',
    rows: incrementalRows.map((row) => row.slice()),
    schema: incrementalSchema,
  }, {
    sheetsApi: fakeSheets(incrementalChanges),
    linkedinMcp: incrementalProvider,
    concurrency: 1,
    providerTimeoutMs: 120000,
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(
    incrementalChanges.some((item) => /fast-company/i.test(item.value)),
    'Fast verified company link should be written before a slow sibling lookup completes.',
  );
  releaseSlow();
  const incrementalResult = await incrementalPromise;
  assert.equal(incrementalResult.ok, true);
  assert.equal(incrementalResult.stats.companyLinksFilled, 2);
  assert.equal(changes.length, 2);
  assert.ok(changes.some((item) => item.value === 'https://www.linkedin.com/company/acme-technologies/'));
  assert.ok(changes.some((item) => item.value === 'https://www.linkedin.com/in/alice-smith/'));
  assert.equal(changes.some((item) => /bob-jones/i.test(item.value)), false);
  assert.equal(changes.some((item) => /apollo/i.test(item.source)), false);
  assert.equal(linkedin.calls.some((call) => /apollo/i.test(call.tool)), false);

  const noGapCalls = [];
  const noGapResult = await linkEnricher.run({
    spreadsheetId: 'abc123',
    sheetName: 'salesforce/oracle/tech',
    rows: [[
      'Company Name', 'Company LinkedIn', 'POC 1 Name', 'POC 1 LinkedIn',
    ], [
      'Acme Technologies',
      'https://www.linkedin.com/company/acme-technologies/',
      'Alice Smith',
      'https://www.linkedin.com/in/alice-smith/',
    ]],
    schema: schema.inferSchema([[
      'Company Name', 'Company LinkedIn', 'POC 1 Name', 'POC 1 LinkedIn',
    ], [
      'Acme Technologies',
      'https://www.linkedin.com/company/acme-technologies/',
      'Alice Smith',
      'https://www.linkedin.com/in/alice-smith/',
    ]]),
  }, {
    sheetsApi: fakeSheets(noGapCalls),
    linkedinMcp: {
      callTool: async () => { throw new Error('LinkedIn must not be called for a no-gap sheet.'); },
    },
  });
  assert.equal(noGapResult.activated, false);
  assert.equal(noGapResult.noOp, true);
  assert.equal(noGapCalls.length, 0);

  console.log('LinkedIn link sheet enricher selftest: PASS');
}

main().catch((error) => {
  console.error('LinkedIn link sheet enricher selftest: FAIL');
  console.error(error.stack || error);
  process.exitCode = 1;
});
