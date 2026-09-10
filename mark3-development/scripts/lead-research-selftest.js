#!/usr/bin/env node
const assert = require('assert');
const research = require('../core/lead-research-operator');
const paid = require('../core/paid-tool-approval');

const command = 'Ultron, find me 30 HR managers from SaaS companies in Bangalore and fill this sheet with email and phone: https://docs.google.com/spreadsheets/d/abc123/edit';
const parsed = research.parseRequest(command);
assert.ok(parsed);
assert.equal(parsed.sheetUrl, 'https://docs.google.com/spreadsheets/d/abc123/edit');
assert.equal(parsed.count, 30);
assert.match(parsed.criteria, /HR managers/i);
assert.match(parsed.criteria, /SaaS companies/i);
assert.equal(parsed.wantsContactEnrichment, true);

assert.equal(research.parseRequest('Ultron, enrich this sheet with Apollo: https://docs.google.com/spreadsheets/d/abc123/edit'), null);
assert.equal(research.parseCount('find 250 leads and fill the sheet'), 100);
assert.equal(research.keyForHeader('LinkedIn Profile URL'), 'linkedin');
assert.equal(research.keyForHeader('Work Email'), 'email');
assert.equal(research.keyForHeader('Mobile Number'), 'phone');

const lead = research.parseLead({
  title: 'Aakash Sharma - Senior Recruiter at Acme Labs | LinkedIn',
  url: 'https://www.linkedin.com/in/aakash-sharma/',
  snippet: 'Hiring now. Contact aakash@acme.example.com or WhatsApp +91 98765 43210.',
}, 'site:linkedin.com/in recruiter');
assert.ok(lead);
assert.equal(lead.name, 'Aakash Sharma');
assert.equal(lead.role, 'Senior Recruiter');
assert.equal(lead.company, 'Acme Labs');
assert.equal(lead.email, 'aakash@acme.example.com');
assert.equal(lead.phone, '+919876543210');

assert.throws(() => paid.assertPermitted('apollo'), (error) => error?.code === 'PAID_TOOL_APPROVAL_REQUIRED');

(async () => {
  const fakeApproval = { id: 'test-approval', tool: 'apollo', status: 'approved' };
  const permitted = await paid.withPermit(fakeApproval, async () => paid.isPermitted('apollo'));
  assert.equal(permitted, true);
  assert.equal(paid.isPermitted('apollo'), false);
  console.log('Lead research self-test passed. Research-to-Sheets parsing, public contact recovery and one-run paid-tool approval boundaries are healthy.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
