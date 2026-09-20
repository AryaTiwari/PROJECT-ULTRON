'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

require('../core/universal-deterministic-bootstrap').install();
const operator = require('../core/universal-sheet-enrichment-operator');
const fallbackPass = require('../core/universal-big-pickle-fallback-pass');
const contactQuality = require('../core/apollo-three-poc-quality');

assert.equal(typeof operator.enrichAnchorGroup, 'function', 'Big Pickle fallback must be able to call the deterministic anchor-enrichment helper');
const fallbackStats = fallbackPass.freshStats();
assert.ok(Array.isArray(fallbackStats.existingRepairAudit), 'fallback stats must support deterministic existing-contact repair audit');
assert.equal(fallbackStats.phoneCellsFilled, 0, 'fallback stats must understand universal phone-completion accounting');

const company = { company: 'Sunrise Systems, Inc', domain: 'sunrisesys.com' };
const existing = {
  group: {
    id: 'person_2',
    ordinal: 2,
    fields: {
      name: { index: 7, header: '2nd POC Name' },
      phone: { index: 8, header: 'Phone no' },
      email: { index: 9, header: 'Email ID' },
    },
  },
  snapshot: {
    values: {
      name: 'Hemanth Raj — Associate Team Lead - Talent Acquisition',
      phone: '',
      email: 'hemanth.r@sunrisesys.com',
      linkedin: '',
    },
    hasIdentity: true,
    linkedinKind: 'none',
  },
  isAnchor: false,
};

const verificationContext = operator.existingPersonVerificationContext(existing, company);
assert.equal(verificationContext.domain, 'sunrisesys.com');
assert.equal(verificationContext.source, 'existing-poc-business-email-domain');

assert.equal(
  operator.emailLocalPartMatchesAnchor('apoorva.r@sunrisebiztechsys.com', 'Apoorva Wanegaon'),
  true,
  'author-name business email should be accepted as exact row contact evidence',
);
assert.equal(
  operator.emailLocalPartMatchesAnchor('careers@onmogsoftsol.com', 'Donthala Yaswanthi'),
  false,
  'generic careers mailbox must never be treated as exact person evidence',
);
assert.equal(
  operator.emailLocalPartMatchesAnchor('esha@mappoptimist.com', 'Esha Joshi'),
  true,
  'exact four-letter first-name business email should be accepted when the local part equals the name token',
);
assert.equal(
  operator.emailLocalPartMatchesAnchor('hr@a3nity.com', 'Arika Mishra'),
  false,
  'generic HR mailbox must never be treated as exact person evidence',
);

const rowEvidencePlan = {
  anchor: {
    type: 'person',
    snapshot: { values: { name: 'Apoorva Wanegaon', email: '', phone: '' } },
    group: { fields: { email: { index: 4 }, phone: { index: 3 } } },
  },
  context: {
    post: 'Interested candidates can DM me their updated resume on 6366856630 OR apoorva.r@sunrisebiztechsys.com',
  },
};
const rowContact = operator.extractAnchorContactEvidence(rowEvidencePlan);
assert.equal(rowContact.email, 'apoorva.r@sunrisebiztechsys.com');
assert.equal(rowContact.phone, '6366856630');
assert.equal(rowContact.source, 'row-author-contact-evidence');

assert.equal(
  contactQuality.phoneFromPayload({
    people: [{
      waterfall: {
        phone_numbers: [{
          vendors: [{ phone_numbers: [{ sanitized_number: '+919876543210' }] }],
        }],
      },
    }],
  }),
  '+919876543210',
  'phone waterfall parser must recover nested vendor phone numbers',
);

assert.equal(
  contactQuality.phoneFromPayload({
    person: { phone_numbers: [{ raw_number: '+12025550123' }] },
  }),
  '+12025550123',
  'phone waterfall parser must also accept direct person phone_numbers',
);

const queue = [];
operator.queuePendingPhone(
  { pendingPhoneQueue: queue },
  7,
  existing.group,
  existing.snapshot,
  { id: 'apollo-hemanth', name: 'Hemanth Raj', phoneStatus: 'pending', phone: '' },
);
assert.equal(queue.length, 1, 'verified Apollo person with pending phone must enter end-of-run phone sync');
assert.equal(queue[0].rowNumber, 7);
assert.equal(queue[0].columnIndex, 8);
assert.equal(queue[0].apolloPersonId, 'apollo-hemanth');

const directQueue = [];
operator.queuePendingPhone(
  { pendingPhoneQueue: directQueue },
  9,
  existing.group,
  existing.snapshot,
  {
    id: 'apollo-direct',
    name: 'Direct Poll Person',
    phoneStatus: 'pending',
    phoneRequestId: '1039995589705121975',
    phone: '',
  },
);
assert.equal(directQueue.length, 1, 'native Apollo pending phone with request_id must be owned by the exact sheet cell');
assert.equal(directQueue[0].phoneMode, 'native');
assert.equal(directQueue[0].phoneRequestId, '1039995589705121975');

const waterfallQueue = [];
operator.queuePendingPhone(
  { pendingPhoneQueue: waterfallQueue },
  8,
  existing.group,
  existing.snapshot,
  {
    id: 'apollo-waterfall',
    name: 'Waterfall Person',
    phoneStatus: 'waterfall_pending',
    phoneWaterfallRequestId: 'wf-request-123',
    phone: '',
  },
);
assert.equal(waterfallQueue.length, 1, 'poll-only waterfall phone must be persisted for background request-id polling');
assert.equal(waterfallQueue[0].phoneMode, 'waterfall');
assert.equal(waterfallQueue[0].phoneWaterfallRequestId, 'wf-request-123');
assert.equal(waterfallQueue[0].key, '8|8', 'pending phone ownership must be unique by row/cell rather than historical person ids');

operator.queuePendingPhone(
  { pendingPhoneQueue: queue },
  7,
  existing.group,
  existing.snapshot,
  { id: 'apollo-hemanth', name: 'Hemanth Raj', phoneStatus: 'pending', phone: '' },
);
assert.equal(queue.length, 1, 'same person/cell phone request must not be queued twice');

const completedSnapshot = { ...existing.snapshot, values: { ...existing.snapshot.values, phone: '+919999999999' } };
operator.queuePendingPhone(
  { pendingPhoneQueue: queue },
  7,
  existing.group,
  completedSnapshot,
  { id: 'apollo-hemanth', name: 'Hemanth Raj', phoneStatus: 'pending', phone: '' },
);
assert.equal(queue.length, 1, 'already-populated phone cell must never be queued for overwrite');

const root = path.join(__dirname, '..', 'core');
const operatorSource = fs.readFileSync(path.join(root, 'universal-sheet-enrichment-operator.js'), 'utf8');
const bootstrapSource = fs.readFileSync(path.join(root, 'universal-deterministic-bootstrap.js'), 'utf8');
const fallbackSource = fs.readFileSync(path.join(root, 'universal-big-pickle-fallback.js'), 'utf8');
const contactQualitySource = fs.readFileSync(path.join(root, 'apollo-three-poc-quality.js'), 'utf8');
const apolloSource = fs.readFileSync(path.join(root, 'apollo-enrichment.js'), 'utf8');

assert.doesNotMatch(operatorSource, /existingRepairNeedsDiscovery/);
assert.doesNotMatch(operatorSource, /exactCandidateForExisting/);
assert.match(operatorSource, /existingPersonVerificationContext/);
assert.match(operatorSource, /extractAnchorContactEvidence/);
assert.match(operatorSource, /emailLocalPartMatchesAnchor/);
assert.match(operatorSource, /row-author-contact-evidence/);
assert.match(operatorSource, /apollo-business-email/);
assert.match(operatorSource, /apollo\.resolvePersonByBusinessEmail/);
assert.match(operatorSource, /apollo-name-company/);
assert.match(operatorSource, /apollo\.fetchPhoneResults\(\)/);
assert.match(operatorSource, /apollo\.pollWebhookResult\(item\.phoneRequestId/);
assert.match(operatorSource, /phoneDirectPollResolved/);
assert.match(operatorSource, /phoneRequestId/);
assert.match(apolloSource, /async function pollWebhookResult/);
assert.match(apolloSource, /function requestIdFromRaw/);
assert.match(operatorSource, /apollo\.recordPhoneResult/);
assert.match(operatorSource, /sheets\.readCell/);
assert.match(operatorSource, /sheets\.isBlank/);
assert.match(operatorSource, /syncPendingPhoneAssignments\(source, pendingPhoneQueue/);
assert.match(operatorSource, /existingRepairAudit/);
assert.match(operatorSource, /phoneStillPending/);
assert.match(operatorSource, /pending-phone-assignments\.json/);
assert.match(operatorSource, /persistBackgroundPhoneAssignments/);
assert.match(operatorSource, /loadBackgroundPhoneAssignments/);
assert.match(operatorSource, /resumedPhoneAssignments/);

// Native Apollo reveal/webhook is the production phone path. The custom
// poll-only phone waterfall is retained only as an explicit experimental/legacy
// compatibility path so already-paid request IDs remain resumable.
assert.match(apolloSource, /run_waterfall_phone', 'false'/);
assert.match(apolloSource, /reveal_phone_number', needPhone \? 'true' : 'false'/);
assert.match(contactQualitySource, /ULTRON_M3_THREE_POC_PHONE_WATERFALL_EXPERIMENTAL', '0'/);
assert.match(contactQualitySource, /Native Apollo reveal \+ webhook settlement is the production default/);
assert.match(contactQualitySource, /async function improveVerifiedPhone/);
assert.match(contactQualitySource, /async function pollPhoneRequest/);
assert.match(contactQualitySource, /function pendingPhoneWaterfallRequestId/);
assert.match(contactQualitySource, /function carryLegacyPhoneRequest/);
assert.match(contactQualitySource, /phoneStatus: 'waterfall_pending'/);
assert.match(contactQualitySource, /function baseOptionsForQuality/);
assert.match(operatorSource, /item\.phoneMode === 'waterfall'/);
assert.match(operatorSource, /quality\.pollPhoneRequest\(item\.phoneWaterfallRequestId, \{ polls: 0 \}\)/);
assert.match(operatorSource, /backgroundPhoneKey\(source, item\)/);
assert.match(contactQualitySource, /originalResolvePersonByBusinessEmail/);
assert.match(contactQualitySource, /runState\.phoneWaterfallNotFound\+\+/);
assert.match(contactQualitySource, /runState\.waterfallNotFound\+\+/);
assert.match(contactQualitySource, /originalResolvePersonProfile/);
assert.match(contactQualitySource, /apollo\.resolvePersonProfile = async function resultsFirstResolvePersonProfile/);
assert.match(contactQualitySource, /improveVerifiedContacts\(carryLegacyPhoneRequest\(result, legacyPhoneRequestId\), options\)/);
assert.match(contactQualitySource, /if \(options\.needPhone !== false\) next = await improveVerifiedPhone\(next\)/);
assert.match(operatorSource, /Final-POC contact waterfall:/);
assert.match(operatorSource, /const anchorContactHydrationNeeded = \(!phaseOrdinal \|\| phaseOrdinal === 1\)[\s\S]*?anchorNeedsHydration\(plan, anchorContactEvidence\)/);
assert.match(operatorSource, /completeContacts: true/);
assert.match(operatorSource, /contactEvidence: anchorContactEvidence/);
assert.match(operatorSource, /completeContacts: false/);

assert.match(bootstrapSource, /apollo-three-poc-quality/);
assert.match(bootstrapSource, /three-poc-candidate-discovery-policy/);
assert.match(bootstrapSource, /const contactQuality = apolloQuality\.install\(\)/);
assert.match(bootstrapSource, /const highRecallDiscovery = candidateDiscovery\.install\(\)/);

assert.match(fallbackSource, /try \{\s*return await control\.runInternalInference\('spreadsheet-enrichment'/s);
assert.match(fallbackSource, /catch \(error\) \{\s*state\.failures\+\+;\s*state\.lastError/s);
assert.match(operatorSource, /repairExistingGroups,\s*enrichAnchorGroup,/s);

async function run() {
  const apollo = require('../core/apollo-enrichment');
  const sheets = require('../core/google-sheets-operator');
sheets.batchValues=async(id,ranges)=>Promise.all(ranges.map(range=>sheets.values(id,range)));
  const originals = {
    fetchPhoneResults: apollo.fetchPhoneResults,
    pollWebhookResult: apollo.pollWebhookResult,
    recordPhoneResult: apollo.recordPhoneResult,
    consumePhoneResult: apollo.consumePhoneResult,
    readCell: sheets.readCell,
    values: sheets.values,
    writeCells: sheets.writeCells,
  };
  const writes = [];
  const oldPendingRetry = process.env.ULTRON_M3_APOLLO_PENDING_PHONE_RETRY_MINUTES;
  process.env.ULTRON_M3_APOLLO_PENDING_PHONE_RETRY_MINUTES = '3';
  try {
    assert.equal(
      apollo.pendingPhoneRequestFresh({
        phoneStatus: 'pending',
        phoneRequestedAt: new Date().toISOString(),
      }),
      true,
      'fresh Apollo pending phone request should be reused briefly',
    );
    assert.equal(
      apollo.pendingPhoneRequestFresh({
        phoneStatus: 'pending',
        phoneRequestedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      }),
      false,
      'stale Apollo pending phone request must become eligible for reveal retry',
    );
    apollo.fetchPhoneResults = async () => [{ apollo_person_id: 'apollo-hemanth', phone: '+919876543210' }];
    apollo.pollWebhookResult = async (requestId) => {
      assert.equal(requestId, '1039995589705121975');
      return { state: 'found', phone: '+919123456789' };
    };
    apollo.recordPhoneResult = () => ['https://www.linkedin.com/in/hemanth-test'];
    apollo.consumePhoneResult = async () => true;
    sheets.readCell = async () => '';
    sheets.values = async (_id, range) => {
      const item = range.endsWith('9:9') ? directQueue[0] : queue[0];
      const row = [];
      for (const [field, descriptor] of Object.entries(item.ownerFields)) row[descriptor.index] = range.endsWith('1:1') ? descriptor.header : (field === 'name' ? item.personName : field === 'linkedin' ? item.personLinkedin : '');
      if (!range.endsWith('1:1')) row[item.columnIndex] = await sheets.readCell();
      return [row];
    };
    sheets.writeCells = async (_id, changes) => {
      writes.push(...changes);
      return { updatedCells: changes.length };
    };

    const stats = operator.freshStats();
    await operator.syncPendingPhoneAssignments(
      { spreadsheetId: 'sheet-test', sheetName: 'Arya 2', schema: {headerRowNumber:1} },
      queue,
      stats,
      { phoneSyncPolls: 1, phoneSyncWaitMs: 1 },
    );
    assert.equal(writes.length, 1, 'one verified pending phone should be written');
    assert.equal(writes[0].range, "'Arya 2'!I7");
    assert.equal(writes[0].value, '+919876543210');
    assert.equal(stats.phoneCellsFilled, 1);
    assert.equal(stats.phoneStillPending, 0);

    writes.length = 0;
    const directStats = operator.freshStats();
    await operator.syncPendingPhoneAssignments(
      { spreadsheetId: 'sheet-test', sheetName: 'Arya 2', schema: {headerRowNumber:1} },
      directQueue,
      directStats,
      { phoneDirectPolls: 0, phoneSyncPolls: 1, phoneSyncWaitMs: 1 },
    );
    assert.equal(writes.length, 1, 'native request-id polling should write a ready phone without waiting for the worker');
    assert.equal(writes[0].range, "'Arya 2'!I9");
    assert.equal(writes[0].value, '+919123456789');
    assert.equal(directStats.phoneDirectPollResolved, 1);
    assert.equal(directStats.phoneStillPending, 0);

    writes.length = 0;
    sheets.readCell = async () => '+911111111111';
    const populatedStats = operator.freshStats();
    await operator.syncPendingPhoneAssignments(
      { spreadsheetId: 'sheet-test', sheetName: 'Arya 2', schema: {headerRowNumber:1} },
      queue,
      populatedStats,
      { phoneSyncPolls: 1, phoneSyncWaitMs: 1 },
    );
    assert.equal(writes.length, 0, 'existing phone must never be overwritten by webhook completion');
    assert.equal(populatedStats.phoneWriteSkippedPopulated, 1);
  } finally {
    if (oldPendingRetry == null) delete process.env.ULTRON_M3_APOLLO_PENDING_PHONE_RETRY_MINUTES;
    else process.env.ULTRON_M3_APOLLO_PENDING_PHONE_RETRY_MINUTES = oldPendingRetry;
    apollo.fetchPhoneResults = originals.fetchPhoneResults;
    apollo.pollWebhookResult = originals.pollWebhookResult;
    apollo.recordPhoneResult = originals.recordPhoneResult;
    apollo.consumePhoneResult = originals.consumePhoneResult;
    sheets.readCell = originals.readCell;
    sheets.values = originals.values;
    sheets.writeCells = originals.writeCells;
  }

  console.log('Universal contact completion self-test passed: existing POCs verify exactly, native Apollo reveal/webhook is the default phone-completion path, already-paid legacy waterfall request IDs remain resumable by exact sheet cell, native Apollo request IDs are polled in-run before worker fallback, pending native callbacks remain resume-safe, populated phone cells are never overwritten, and nested legacy waterfall payloads still parse safely.');
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { run };
