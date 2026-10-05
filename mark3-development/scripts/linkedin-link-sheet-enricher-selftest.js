'use strict';

const assert = require('assert/strict');
const schema = require('../core/universal-sheet-schema');
const linkEnricher = require('../core/linkedin-link-sheet-enricher');
const commandControl = require('../core/command-control-plane');
const universalSheetController = require('../core/universal-spreadsheet-domain-controller');

function fakeSheets(changes) {
  return {
    linkedInHyperlinks: async () => new Map(),
    batchValues: async (_id, ranges) => ranges.map(() => ['']),
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
  const searchHeavyLinkedInRequest = `ULTRON, run the isolated LinkedIn-link enrichment pass only for the \`salesforce/oracle/tech\` worksheet.

## COMPANY LINKEDIN ENRICHMENT
- Search for the matching LinkedIn company profile.
- Verify the company identity before writing.

## POC LINKEDIN ENRICHMENT
- Search for the matching LinkedIn person profile.
- Verify the person identity and current company/employer.

## PRESERVATION RULES
- Never overwrite a populated LinkedIn cell.
- Do not modify phone numbers, emails, designations, company names, or any other fields.
- Do not perform Apollo enrichment.
- No Apollo.
- Do not run the normal phone/email/POC enrichment flow.

Google Sheet:
${sheetUrl}

Worksheet: \`salesforce/oracle/tech\``;

  assert.equal(
    commandControl.isLinkedInSheetLinkEnrichmentRequest(searchHeavyLinkedInRequest),
    true,
    'Search-heavy isolated LinkedIn-link prompt must not be reclassified as generic LinkedIn lead discovery.',
  );
  assert.equal(
    commandControl.claim(searchHeavyLinkedInRequest).domain,
    'linkedin-sheet-links',
  );
  assert.equal(
    universalSheetController.parseSheetName(exactLinkedInRequest),
    'salesforce/oracle/tech',
  );

  const explicitSheetResume = `resume enrichment in this sheet fill it with 1st poc and 2nd poc phone and email

Google Sheet:
${sheetUrl}

Worksheet: salesforce/oracle/tech`;
  assert.equal(
    commandControl.isExplicitPaidApprovalReply(explicitSheetResume),
    false,
    'A new sheet-resume command must never be treated as an Apollo approval reply.',
  );
  assert.equal(
    commandControl.claim(explicitSheetResume).domain,
    'spreadsheet-enrichment',
    'A sheet-scoped resume command must route to universal spreadsheet enrichment.',
  );
  assert.equal(
    universalSheetController.parseSheetName(explicitSheetResume),
    'salesforce/oracle/tech',
    'Plain Worksheet: <name> syntax must preserve the exact worksheet target.',
  );
  assert.equal(
    commandControl.isExplicitPaidApprovalReply('approve Apollo'),
    true,
    'A genuine Apollo approval reply must remain approval-routable.',
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
    concurrency: 2,
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
