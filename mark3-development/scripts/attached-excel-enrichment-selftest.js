#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const localExcel = require('../core/local-excel-operator');
const leads = require('../core/lead-enrichment-bootstrap');
const paid = require('../core/paid-tool-approval');
const input = require('../core/input-intelligence');

const fakeAttachment = {
  id: 'file-selftest-090926',
  name: '090926-1.xlsx',
  mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const source = localExcel.attachmentSource([fakeAttachment], '@090926-1 enrich this with email and number');
assert.ok(source);
assert.equal(source.provider, 'local-excel');
assert.equal(source.url, 'vault:file-selftest-090926');

const request = leads.isEnrichmentRequest('@090926-1 enrich this with email and number', { attachments: [fakeAttachment] });
assert.ok(request);
assert.equal(request.provider, 'local-excel');
assert.equal(request.invalidUrl, false);
assert.equal(request.ensureContactColumns, true);

assert.equal(paid.approvalAttempt('go for it approved'), true);
assert.deepEqual(paid.approvalModifiers('go for it approved'), {});
assert.equal(paid.approvalAttempt('approve and also make phone and email columns'), true);
assert.deepEqual(paid.approvalModifiers('approve and also make phone and email columns'), { ensureContactColumns: true });

const stateFile = paid.STATE_FILE;
const existed = fs.existsSync(stateFile);
const backup = existed ? fs.readFileSync(stateFile) : null;
try {
  paid.request('apollo', 'lead-enrichment', { url: source.url, provider: source.provider, ensureContactColumns: true }, 'self-test');
  const resolution = input.resolve('go for it approved');
  assert.equal(resolution.intent, 'paid-tool-approval');
  assert.equal(resolution.source, 'pending-apollo-approval');
  assert.equal(resolution.clarification, null);

  const decision = paid.resolveMessage('go for it approved');
  assert.ok(decision);
  assert.equal(decision.status, 'approved');
  assert.equal(decision.tool, 'apollo');
} finally {
  if (backup) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, backup);
  } else {
    try { fs.unlinkSync(stateFile); } catch {}
  }
}

console.log('Attached Excel enrichment self-test passed. @filename contact enrichment routes to the local Excel adapter, Apollo approval remains explicit, and natural approvals bypass vague-command clarification.');