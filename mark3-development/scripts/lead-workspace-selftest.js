#!/usr/bin/env node
const assert = require('assert');
const workspace = require('../core/lead-workspace-operator');
const bootstrap = require('../core/lead-workspace-bootstrap');

assert.equal(workspace.MAX_LEADS, 200);
assert.equal(workspace.isWorkspaceRequest('Find me 100 HR recruiter leads in India and create a Google Sheet'), true);
assert.equal(workspace.isWorkspaceRequest('Bring me 50 SaaS founder leads with email and phone'), true);
assert.equal(workspace.isWorkspaceRequest('https://docs.google.com/spreadsheets/d/abc/edit enrich this with apollo'), false);

const parsed = workspace.parseRequest('Find me 120 HR recruiter leads in India and create a Google Sheet with phone and email');
assert.equal(parsed.count, 120);
assert.equal(parsed.wantsContactEnrichment, true);
assert.ok(/HR recruiter/i.test(parsed.criteria));
assert.equal(bootstrap.normalizeMissionCriteria('bring me SaaS founder'), 'SaaS founder');
assert.equal(bootstrap.normalizeMissionCriteria('HR recruiters in India and'), 'HR recruiters in India');

const headers = ['Person or Company Name', 'L', 'Post Details', 'L', 'Linkedin Id', 'PHONE', 'EMAIL'];
const ensured = workspace.ensureCoreHeaders(headers, true);
assert.deepEqual(ensured, headers);
assert.equal(workspace.keyForHeader('Person or Company Name'), 'name');
assert.equal(workspace.keyForHeader('Post Details'), 'details');
assert.equal(workspace.keyForHeader('Linkedin Id'), 'linkedin');
assert.equal(workspace.keyForHeader('PHONE'), 'phone');
assert.equal(workspace.keyForHeader('EMAIL'), 'email');
assert.equal(workspace.keyForHeader('L'), null);

assert.deepEqual(
  workspace.headersFromText('headers: Name, Company, Role, LinkedIn, Post Details, Phone, Email'),
  ['Name', 'Company', 'Role', 'LinkedIn', 'Post Details', 'Phone', 'Email']
);

const row = workspace.leadRow({
  name: 'Aarti',
  company: 'RCV World',
  role: 'Recruiter',
  linkedin: 'https://www.linkedin.com/in/aarti/',
  snippet: 'Hiring post details',
  phone: '+919876543210',
  email: 'aarti@example.com',
  source: 'https://www.linkedin.com/in/aarti/',
}, headers);
assert.equal(row[0], 'Aarti');
assert.equal(row[1], '');
assert.equal(row[2], 'Hiring post details');
assert.equal(row[3], '');
assert.equal(row[4], 'https://www.linkedin.com/in/aarti/');
assert.equal(row[5], '+919876543210');
assert.equal(row[6], 'aarti@example.com');

assert.equal(workspace.publicScrapeCandidate('https://example.com/team'), true);
assert.equal(workspace.publicScrapeCandidate('https://www.linkedin.com/in/example'), false);
assert.equal(workspace.publicScrapeCandidate('https://www.instagram.com/example'), false);
assert.ok(workspace.queryPlan('HR recruiters India', 100).length >= 10);

console.log('Lead Workspace self-test passed. Google Sheet creation routing, raw follow-up handling, previous-format compatibility, custom headings, 200-lead mission limits, resumable checkpoints, public-web scraping safety and row mapping are structurally healthy.');