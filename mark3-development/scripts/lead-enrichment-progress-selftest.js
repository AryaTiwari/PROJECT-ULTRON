#!/usr/bin/env node
const assert = require('assert');
const progress = require('../core/lead-enrichment-progress');

assert.equal(progress.contextualPhoneFromText('Interested candidates can DM me on -9684020880'), '+919684020880');
assert.equal(progress.contextualPhoneFromText('Email recruiter@company.com or 7981789239'), '+917981789239');
assert.equal(progress.contextualPhoneFromText('Share your CV / profile: 9876543210'), '+919876543210');
assert.equal(progress.contextualPhoneFromText('Salary: 9876543210'), null);
assert.equal(progress.contextualPhoneFromText('Job ID: 9876543210'), null);
assert.equal(progress.contextualPhoneFromText('Experience: 9876543210'), null);

assert.equal(progress.isStatusRequest('Ultron, enrichment status'), true);
assert.equal(progress.isStatusRequest('phone verification status'), true);
assert.equal(progress.isFreePhoneSyncRequest('sync phone results'), true);
assert.equal(progress.isFreePhoneSyncRequest('check webhook results'), true);
assert.equal(progress.isFreePhoneSyncRequest('resume Apollo enrichment'), false);

assert.equal(progress.cellState(''), 'blank');
assert.equal(progress.cellState(' null '), 'no_data');
assert.equal(progress.cellState('+919999999999'), 'found');

const now = Date.now();
const old = new Date(now - 25 * 60_000).toISOString();
const recent = new Date(now - 2 * 60_000).toISOString();
const created = new Date(now - 30 * 60_000).toISOString();

const metricJob = {
  id: 'job-main',
  provider: 'google',
  spreadsheetId: 'sheet-090926',
  sheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-090926/edit',
  spreadsheetTitle: '090926-1',
  sheetName: 'Sheet1',
  status: 'waiting_for_phone_webhooks',
  createdAt: created,
  stats: {
    scannedRows: 67,
    enrichedProfiles: 51,
    cachedProfiles: 8,
    sheetEmailsRecovered: 56,
    sheetPhonesRecovered: 7,
    contextualPhonesRecovered: 1,
    pendingPhones: 42,
  },
  rows: {
    '2': { rowNumber: 2, linkedinUrl: 'https://www.linkedin.com/in/a', phonePending: false, phoneResolved: true, phone: '+919999999999', requestedAt: recent },
    '3': { rowNumber: 3, linkedinUrl: 'https://www.linkedin.com/in/b', phonePending: false, phoneResolved: true, phone: null, requestedAt: recent },
  },
};

// Simulates a later legacy/callback-only job that has phone state but no full run stats.
// Status must inherit the real 67/51/8 counters from the matching completed run instead
// of presenting synthetic zeroes.
const callbackOnlyJob = {
  id: 'job-callback-only',
  provider: 'google',
  spreadsheetId: 'sheet-090926',
  sheetUrl: metricJob.sheetUrl,
  spreadsheetTitle: '090926-1',
  sheetName: 'Sheet1',
  status: 'waiting_for_phone_webhooks',
  createdAt: new Date(now - 10 * 60_000).toISOString(),
  rows: {
    '4': { rowNumber: 4, linkedinUrl: 'https://www.linkedin.com/in/c', phonePending: true, requestedAt: old },
    '5': { rowNumber: 5, linkedinUrl: 'https://www.linkedin.com/in/d', phonePending: true, requestedAt: recent },
  },
};

const summary = progress.latestJobSummary({ version: 1, jobs: [metricJob, callbackOnlyJob] }, now);
assert.equal(summary.metricsAvailable, true);
assert.equal(summary.reconstructedMetrics, true);
assert.equal(summary.scannedRows, 67);
assert.equal(summary.liveCalls, 51);
assert.equal(summary.cacheHits, 8);
assert.equal(summary.localEmails, 56);
assert.equal(summary.localPhones, 8);
assert.equal(summary.initialPending, 42);
assert.equal(summary.resolved, 2);
assert.equal(summary.resolvedWithPhone, 1);
assert.equal(summary.resolvedNoPhone, 1);
assert.equal(summary.pending, 2);
assert.equal(summary.stalePending, 1);

const text = progress.buildStatusText({
  providers: { google: true, microsoft: true, localExcel: true },
  apollo: { apiKeyReady: true, webhookReady: true },
  pendingPhones: 2,
}, summary, { received: 0, resolved: 0, pending: 2 }, {
  linkedinRows: 67,
  phone: { found: 25, noData: 40, blank: 2 },
  email: { found: 64, noData: 3, blank: 0 },
});

assert.match(text, /67 LinkedIn rows checked/);
assert.match(text, /Apollo live calls 51, cache hits 8/);
assert.match(text, /matching completed job instead of showing false zeroes/);
assert.match(text, /42 unique phone checks tracked; 2 resolved, 2 pending/);
assert.match(text, /phone 25 found, 40 confirmed no-data, 2 blank/);
assert.match(text, /No new phone callback arrived in this sync/);
assert.match(text, /0 new Apollo enrichment calls/);
assert.match(text, /pending over 20 minutes/);

const legacy = progress.summarizeJob({
  id: 'legacy',
  provider: 'google',
  spreadsheetId: 'legacy-sheet',
  sheetName: 'Sheet1',
  rows: { '9': { rowNumber: 9, phonePending: true, requestedAt: recent } },
}, now);
assert.equal(legacy.metricsAvailable, false);
assert.equal(legacy.scannedRows, null);
assert.equal(legacy.liveCalls, null);

console.log('Lead enrichment progress self-test passed. Campaign-aware metrics, live sheet coverage, callback sync reporting and contextual phone recovery are healthy.');
