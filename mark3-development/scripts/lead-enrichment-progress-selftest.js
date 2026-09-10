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

const now = Date.now();
const old = new Date(now - 25 * 60_000).toISOString();
const recent = new Date(now - 2 * 60_000).toISOString();
const summary = progress.summarizeJob({
  id: 'job-1',
  provider: 'google',
  spreadsheetTitle: '090926-1',
  sheetName: 'Sheet1',
  status: 'waiting_for_phone_webhooks',
  stats: {
    scannedRows: 67,
    enrichedProfiles: 51,
    cachedProfiles: 8,
    sheetEmailsRecovered: 56,
    sheetPhonesRecovered: 7,
    contextualPhonesRecovered: 1,
    pendingPhones: 4,
  },
  rows: {
    '2': { phonePending: false, phoneResolved: true, phone: '+919999999999', requestedAt: recent },
    '3': { phonePending: false, phoneResolved: true, phone: null, requestedAt: recent },
    '4': { phonePending: true, requestedAt: old },
    '5': { phonePending: true, requestedAt: recent },
  },
}, now);

assert.equal(summary.initialPending, 4);
assert.equal(summary.resolved, 2);
assert.equal(summary.resolvedWithPhone, 1);
assert.equal(summary.resolvedNoPhone, 1);
assert.equal(summary.pending, 2);
assert.equal(summary.stalePending, 1);
assert.equal(summary.localPhones, 8);

const text = progress.buildStatusText({
  providers: { google: true, microsoft: true, localExcel: true },
  apollo: { apiKeyReady: true, webhookReady: true },
  pendingPhones: 2,
}, summary, { received: 2, resolved: 2, pending: 2 });

assert.match(text, /Phone verification started for 4; 2 callback results processed, 2 still pending/);
assert.match(text, /Returned phones: 1 found, 1 confirmed no phone/);
assert.match(text, /Apollo live calls: 51; cache hits: 8/);
assert.match(text, /0 new Apollo enrichment calls/);
assert.match(text, /pending over 20 minutes/);

console.log('Lead enrichment progress self-test passed. Live status refresh, callback accounting, free webhook sync and contextual bare-number recovery are healthy.');
