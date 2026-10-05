'use strict';

const assert = require('assert/strict');
const schema = require('../core/universal-sheet-schema');
const linkEnricher = require('../core/linkedin-link-sheet-enricher');
const commandControl = require('../core/command-control-plane');

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
