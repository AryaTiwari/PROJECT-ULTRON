#!/usr/bin/env node
const assert = require('assert');
const workspace = require('../core/lead-workspace-operator-v3');
const bootstrap = require('../core/lead-workspace-bootstrap');

assert.equal(workspace.MAX_LEADS, 200);
assert.equal(workspace.isWorkspaceRequest('Find me 100 HR recruiter leads in India and create a Google Sheet'), true);
assert.equal(workspace.isWorkspaceRequest('Bring me 50 SaaS founder leads with email and phone'), true);
assert.equal(workspace.isWorkspaceRequest('Make me 40 creator leads in India'), true);
assert.equal(workspace.isWorkspaceRequest('https://docs.google.com/spreadsheets/d/abc/edit enrich this with apollo'), false);
assert.ok(bootstrap.implicitWorkspaceRequest('Find me 80 fitness creator leads in India'));
assert.ok(bootstrap.implicitWorkspaceRequest('Bring me 80 fitness creator leads in India'));
assert.ok(bootstrap.implicitWorkspaceRequest('Make me 80 fitness creator leads in India'));
assert.ok(bootstrap.implicitWorkspaceRequest('Find me 25 marketing agencies in Kolkata from Google Maps'));
assert.ok(bootstrap.implicitWorkspaceRequest('Find me 30 companies hiring SAP consultants on Naukri'));
assert.ok(bootstrap.implicitWorkspaceRequest('Get me 20 employers with Python vacancies from Indeed'));
assert.equal(bootstrap.implicitWorkspaceRequest('How do I find leads for my business?'), null);
assert.equal(bootstrap.implicitWorkspaceRequest('Find me 5 good movies'), null);

const mapsImplicit = bootstrap.implicitWorkspaceRequest('Find me 25 marketing agencies in Kolkata from Google Maps');
assert.equal(mapsImplicit.count, 25);
assert.ok(/founder|owner|marketing decision maker/i.test(mapsImplicit.criteria));
const jobsImplicit = bootstrap.implicitWorkspaceRequest('Find me 30 companies hiring SAP consultants on Naukri');
assert.equal(jobsImplicit.count, 30);
assert.ok(/recruiter|talent acquisition/i.test(jobsImplicit.criteria));

const parsed = workspace.parseRequest('Find me 120 HR recruiter leads in India and create a Google Sheet with phone and email');
assert.equal(parsed.count, 120);
assert.equal(parsed.wantsContactEnrichment, true);
assert.ok(/HR recruiter/i.test(parsed.criteria));
assert.equal(bootstrap.normalizeMissionCriteria('bring me SaaS founder'), 'SaaS founder');
assert.equal(bootstrap.normalizeMissionCriteria('find me 25 marketing agencies in Kolkata'), 'marketing agencies in Kolkata');
assert.equal(bootstrap.normalizeMissionCriteria('HR recruiters in India and'), 'HR recruiters in India');

const headers = ['Person or Company Name', 'L', 'Post Details', 'L', 'Linkedin Id', 'PHONE', 'EMAIL'];
const ensured = workspace.ensureCoreHeaders(headers, true);
assert.deepEqual(ensured, headers);
assert.equal(workspace.keyForHeader('Person or Company Name'), 'name');
assert.equal(workspace.keyForHeader('Post Details'), 'details');
assert.equal(workspace.keyForHeader('Linkedin Id'), 'linkedin');
assert.equal(workspace.keyForHeader('PHONE'), 'phone');
assert.equal(workspace.keyForHeader('EMAIL'), 'email');
assert.equal(workspace.keyForHeader('Lead Score'), 'quality');
assert.equal(workspace.sourceKeyForHeader('Hiring Signal'), 'hiring');
assert.equal(workspace.sourceKeyForHeader('Maps Signal'), 'maps');
assert.equal(workspace.sourceKeyForHeader('Source Count'), 'source_count');
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
  relevanceScore: 88,
  hiringSignal: 'SAP Consultant via Indeed',
  sourceCount: 1,
  sourceEvidence: ['google-jobs'],
}, [...headers, 'Lead Score', 'Hiring Signal', 'Source Count', 'Evidence Sources']);
assert.equal(row[0], 'Aarti');
assert.equal(row[1], '');
assert.equal(row[2], 'Hiring post details');
assert.equal(row[3], '');
assert.equal(row[4], 'https://www.linkedin.com/in/aarti/');
assert.equal(row[5], '+919876543210');
assert.equal(row[6], 'aarti@example.com');
assert.equal(row[7], 88);
assert.equal(row[8], 'SAP Consultant via Indeed');
assert.equal(row[9], 1);
assert.equal(row[10], 'google-jobs');

const strongLead = {
  name: 'Aarti Maurya',
  role: 'HR Recruiter',
  company: 'RCV World',
  linkedin: 'https://www.linkedin.com/in/aarti/',
  snippet: 'Talent acquisition recruiter in India hiring technology candidates.',
};
const weakLead = {
  name: 'Random Developer',
  role: 'Frontend Engineer',
  company: 'Example',
  linkedin: 'https://www.linkedin.com/in/random/',
  snippet: 'JavaScript engineer building design systems.',
};
assert.ok(workspace.leadRelevanceScore(strongLead, 'HR recruiters India') > workspace.leadRelevanceScore(weakLead, 'HR recruiters India'));
assert.equal(workspace.qualifiedLead(strongLead, 'HR recruiters India'), true);
assert.equal(workspace.qualifiedLead(weakLead, 'HR recruiters India'), false);
assert.equal(workspace.identityEvidence('Aarti Maurya is a recruiter at RCV World. Contact aarti@example.com', strongLead), true);
assert.equal(workspace.identityEvidence('Generic contact page for Another Company support@example.com', strongLead), false);

const deduped = workspace.dedupeLeads([
  strongLead,
  { ...strongLead, linkedin: 'https://linkedin.com/in/aarti' },
  { ...strongLead, linkedin: 'https://www.linkedin.com/in/other/' },
]);
assert.equal(deduped.leads.length, 1);
assert.equal(deduped.removed, 2);

assert.equal(workspace.publicScrapeCandidate('https://example.com/team'), true);
assert.equal(workspace.publicScrapeCandidate('https://example.com/login'), false);
assert.equal(workspace.publicScrapeCandidate('https://www.linkedin.com/in/example'), false);
assert.equal(workspace.publicScrapeCandidate('https://www.instagram.com/example'), false);
assert.ok(workspace.queryPlan('HR recruiters India', 100).length >= 20);
assert.ok(workspace.queryPlan('HR recruiters India', 200).length > workspace.queryPlan('HR recruiters India', 30).length);
const budgets = workspace.deepBudgets(200);
assert.ok(budgets.maxLeads >= 60);
assert.ok(budgets.maxFetches >= 40);

const state = workspace.status();
assert.equal(state.stateVersion, 3);
assert.equal(state.formattedSheets, true);
assert.equal(state.relevanceFiltering, true);
assert.equal(state.identityCheckedContactRecovery, true);
assert.equal(state.secondaryDedupe, true);
assert.equal(state.resumableDeepResearch, true);
assert.equal(state.multiSourceRanking, true);
assert.equal(state.sourceAwareColumns, true);
assert.ok(state.sourceFusion && typeof state.sourceFusion.serpApiConfigured === 'boolean');
assert.ok(state.sourceFusion && typeof state.sourceFusion.apifyConfigured === 'boolean');

console.log('Lead Workspace v3 self-test passed. Direct lead, Google Maps and job-board commands, remembered/custom layouts, source-aware columns, relevance scoring, identity-checked contact recovery, dedupe, formatted Google Sheets, resumable checkpoints and SerpApi/Apify source-fusion wiring are structurally healthy.');
