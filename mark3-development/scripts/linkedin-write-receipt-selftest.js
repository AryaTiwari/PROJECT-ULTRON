const assert = require('assert/strict');
const { verifyAppend } = require('../core/linkedin-account-operator');
const router = require('../core/linkedin-command-router');
(async () => {
  const rows = [['Acme', 'https://www.linkedin.com/company/acme', '']];
  const response = { updates: { updatedRows: 1, updatedRange: "'Leads'!A1001:C1001" } };
  const receipt = await verifyAppend(response, rows, async range => { assert.equal(range, response.updates.updatedRange); return [rows[0].slice(0,2)]; });
  assert.equal(receipt.rows, 1);
  await assert.rejects(verifyAppend({}, rows, async () => rows), { code: 'LINKEDIN_SHEET_WRITE_UNVERIFIED' });
  await assert.rejects(verifyAppend(response, rows, async () => []), { code: 'LINKEDIN_SHEET_WRITE_UNVERIFIED' });
  for (const text of ['No Apollo', 'Resume SAP. No Apollo', 'Find email without Apollo', 'Do not use Apollo', 'Discovery only—do not find POCs, emails, or phone numbers, and do not use Apollo']) {
    assert.equal(router.requestedContactEnrichment(text), false);
    assert.equal(router.isApolloEnrichmentRequest(text), false);
  }
  assert.equal(router.requestedContactEnrichment('Enrich those companies with Apollo'), true);
  console.log('LinkedIn write receipt and explicit No Apollo regressions passed. No live writes.');
})().catch(e => { console.error(e); process.exitCode = 1; });
