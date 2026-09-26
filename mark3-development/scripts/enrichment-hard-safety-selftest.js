'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ultron-enrichment-safety-'));
const journal = path.join(tempRoot, 'enrichment-request-journal.json');
process.env.ULTRON_M3_ENRICHMENT_REQUEST_JOURNAL = journal;

fs.writeFileSync(journal, JSON.stringify({
  version: 1,
  requests: [{
    id: 'enrich:interrupted-0001',
    fingerprint: 'fp-interrupted',
    routeDomain: 'three-poc-spreadsheet',
    runtimeId: 'old-runtime',
    status: 'running',
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
  }],
}, null, 2));

const safety = require('../core/enrichment-request-safety');
const threePoc = require('../core/three-poc-enrichment-operator');
const localExcel = require('../core/local-excel-operator');
const bootstrap = require('../core/lead-enrichment-bootstrap');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  try {
    // Exact shape of New_Sheet_14-09-25.xlsx -> "Arya-24 sept".
    const headers = [
      'COMPANY NAME',
      'COMPANY LINK',
      '1st  POC NAME',
      'PHONE',
      'EMAIL',
      '2ND POC NAME',
      'PHONE',
      'EMAIL',
      'Outcome',
    ];
    const layout = threePoc.detectThreePocLayout([headers]);
    assert.equal(layout.slotCount, 2, 'two-POC worksheets must not require a third POC block');
    assert.equal(layout.schema, 'explicit_two_poc');
    assert.equal(layout.first.nameIndex, 2);
    assert.equal(layout.first.phoneIndex, 3);
    assert.equal(layout.first.emailIndex, 4);
    assert.equal(layout.second.nameIndex, 5);
    assert.equal(layout.second.phoneIndex, 6);
    assert.equal(layout.second.emailIndex, 7);
    assert.equal(layout.third, null);

    const exactCommand = '@New_Sheet_14-09-25 sheet - Arya-24 sept enrich this sheet with 1st poc and 2nd poc details and dont delete any lead';
    assert.equal(bootstrap.requestedSheetName(exactCommand), 'Arya-24 sept');
    const selectedTarget = threePoc.selectCompatibleSheets([
      { sheetName: 'Divya', schema: 'explicit_two_poc' },
      { sheetName: 'Arya-24 sept', schema: 'explicit_two_poc' },
      { sheetName: 'Gaurav 2', schema: 'explicit_three_poc' },
    ], bootstrap.requestedSheetName(exactCommand));
    assert.deepEqual(selectedTarget.map((sheet) => sheet.sheetName), ['Arya-24 sept']);
    assert.throws(
      () => threePoc.selectCompatibleSheets([{ sheetName: 'Divya' }], 'Arya-24 sept'),
      (error) => error?.code === 'THREE_POC_TARGET_SHEET_NOT_FOUND',
      'an explicit worksheet target must never fall through to another compatible tab'
    );

    // Existing lead/contact cells are immutable in the compatibility path.
    const existingRow = [
      'Acme Ltd',
      'https://example.com/acme',
      'Existing POC One',
      '+919999999999',
      '',
      '',
      '',
      'existing.poc2@example.com',
      'Open',
    ];
    const people = [
      { name: 'Replacement One', title: 'HR Head', phone: '+918888888888', email: 'one@example.com', linkedinUrl: 'https://www.linkedin.com/in/one' },
      { name: 'New POC Two', title: 'Recruiter', phone: '+917777777777', email: 'two@example.com', linkedinUrl: 'https://www.linkedin.com/in/two' },
    ];
    const changes = threePoc.rowChanges('Arya-24 sept', 2, layout, people, existingRow);
    assert.ok(changes.length > 0);
    assert.ok(changes.every((change) => String(change.value || '').trim()), 'blank candidate data must never become a spreadsheet write');
    const ranges = new Set(changes.map((change) => change.range));
    assert.equal(ranges.has("'Arya-24 sept'!C2"), false, 'existing POC-1 name must be preserved');
    assert.equal(ranges.has("'Arya-24 sept'!D2"), false, 'existing POC-1 phone must be preserved');
    assert.equal(ranges.has("'Arya-24 sept'!H2"), false, 'existing POC-2 email must be preserved');
    assert.equal(ranges.has("'Arya-24 sept'!A2"), false, 'company name must never be an enrichment destination');
    assert.equal(ranges.has("'Arya-24 sept'!B2"), false, 'company link must never be an enrichment destination');
    assert.equal(ranges.has("'Arya-24 sept'!I2"), false, 'Outcome must never be changed by POC enrichment');

    // Every compatibility write is automatically marked non-destructive and
    // blank writes are dropped before the storage adapter sees them.
    const originalLocalWrite = localExcel.writeCells;
    let captured = null;
    localExcel.writeCells = async (_source, writes) => {
      captured = writes;
      return { updatedCells: writes.length };
    };
    try {
      await threePoc.writeSourceCells('vault:test-safety', [
        { range: "'Arya-24 sept'!C2", value: '' },
        { range: "'Arya-24 sept'!F2", value: 'Verified Person' },
      ]);
      assert.equal(captured.length, 1);
      assert.equal(captured[0].range, "'Arya-24 sept'!F2");
      assert.equal(captured[0].nonDestructive, true);
    } finally {
      localExcel.writeCells = originalLocalWrite;
    }

    // Startup converts an in-flight mutation from a dead runtime into an
    // interrupted state rather than silently replaying it.
    const interrupted = safety.status('enrich:interrupted-0001');
    assert.equal(interrupted.status, 'interrupted');
    await assert.rejects(
      () => safety.execute({
        requestId: 'enrich:interrupted-0001',
        requestFingerprint: 'fp-interrupted',
        routeDomain: 'three-poc-spreadsheet',
      }, async () => ({ ok: true })),
      (error) => error?.code === 'ENRICHMENT_REQUEST_INTERRUPTED_NO_REPLAY',
    );

    let missingIdExecutions = 0;
    await assert.rejects(
      () => safety.execute({
        requestId: '',
        requestFingerprint: 'fp-missing-id',
        routeDomain: 'three-poc-spreadsheet',
      }, async () => {
        missingIdExecutions += 1;
        return { ok: true };
      }),
      (error) => error?.code === 'ENRICHMENT_REQUEST_ID_REQUIRED' && Number(error?.status) === 428,
    );
    assert.equal(missingIdExecutions, 0, 'protected enrichment must fail closed before execution when request identity is absent');

    // Two browser submissions with the same mutation identity must join one
    // backend promise. This is the core protection against fetch reconnects.
    const requestId = 'enrich:concurrent-0001';
    const requestFingerprint = safety.fingerprint({
      message: '@New_Sheet_14-09-25 sheet - Arya-24 sept enrich this sheet with 1st poc and 2nd poc details and dont delete any lead',
      inputMode: 'chat',
      routeDomain: 'three-poc-spreadsheet',
      attachments: [{ id: 'file-1', name: 'New_Sheet_14-09-25.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }],
    });
    let executions = 0;
    const executeOnce = () => safety.execute({
      requestId,
      requestFingerprint,
      routeDomain: 'three-poc-spreadsheet',
    }, async () => {
      executions += 1;
      await delay(40);
      return { ok: true, marker: 'same-result' };
    });
    const [first, second] = await Promise.all([executeOnce(), executeOnce()]);
    assert.equal(executions, 1, 'reconnect must not duplicate the protected mutation');
    assert.deepEqual(first, second);

    // A later same-runtime retry gets the completed result, still without
    // running Apollo/writes a second time.
    const third = await executeOnce();
    assert.equal(executions, 1);
    assert.deepEqual(third, first);

    // Reusing a request ID for changed input is blocked.
    await assert.rejects(
      () => safety.execute({
        requestId,
        requestFingerprint: 'different-fingerprint',
        routeDomain: 'three-poc-spreadsheet',
      }, async () => ({ ok: true })),
      (error) => error?.code === 'ENRICHMENT_REQUEST_ID_COLLISION',
    );

    const coreDir = path.join(__dirname, '..', 'core');
    const threePocSource = fs.readFileSync(path.join(coreDir, 'three-poc-enrichment-operator.js'), 'utf8');
    const bootstrapSource = fs.readFileSync(path.join(coreDir, 'lead-enrichment-bootstrap.js'), 'utf8');
    const localExcelSource = fs.readFileSync(path.join(coreDir, 'local-excel-operator.js'), 'utf8');
    const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const transportSource = fs.readFileSync(path.join(__dirname, '..', 'interface', 'chat-transport.js'), 'utf8');

    assert.doesNotMatch(threePocSource, /\b(?:clearRows|deleteRows|deleteDimension|spliceRows)\s*\(/, 'POC enrichment must contain no row-deletion primitive');
    assert.match(localExcelSource, /THREE_POC_NON_DESTRUCTIVE_CONFLICT/);
    assert.match(localExcelSource, /change\.nonDestructive === true/);
    assert.match(bootstrapSource, /requestedSheetName/);
    assert.match(bootstrapSource, /sheetName:\s*decision\.payload\.sheetName/);
    assert.match(threePocSource, /selectCompatibleSheets\(compatible, options\.sheetName/);
    assert.match(serverSource, /enrichmentRequestSafety\.execute/);
    assert.match(serverSource, /ENRICHMENT_REQUEST_ID_REQUIRED/);
    assert.match(serverSource, /x-ultron-request-id/);
    assert.match(transportSource, /X-Ultron-Request-Id/);
    assert.match(transportSource, /ENRICHMENT_RECONNECT_DELAYS_MS/);
    assert.match(transportSource, /protected-approval-pending/);
    assert.match(transportSource, /approvalReply/);
    assert.match(transportSource, /duplicate Apollo calls and spreadsheet writes were blocked/);
    assert.match(threePocSource, /partial_safe_cap/);
    assert.match(threePocSource, /resumeCappedJob/);
    assert.match(threePocSource, /resume_in_progress/);
    assert.match(threePocSource, /resume_interrupted_needs_inspection/);
    assert.match(threePocSource, /resumedByJobId/);
    assert.match(bootstrapSource, /three-poc-enrichment-resume/);
    assert.match(bootstrapSource, /fresh Apollo approval is required/);

    console.log('Enrichment hard-safety self-test passed: exact Arya-24 sept two-POC schema and worksheet targeting are supported, other tabs are fenced off, populated leads cannot be erased, reconnects are idempotent, and runtime interruption cannot silently replay paid/writing work.');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  process.exitCode = 1;
});
