#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const intent = require('../core/linkedin-lead-intent');
const contract = require('../core/linkedin-mission-contract');
const expander = require('../core/linkedin-location-expander');
const operator = require('../core/linkedin-account-operator');
const errors = require('../core/universal-error-catalog');

const parsed = operator.parseRequest('Find 20 companies hiring SAP consultants in Pune in the past month. Put them into my Google Sheet.');
assert.ok(parsed, 'natural company discovery must route without requiring the word LinkedIn');
assert.equal(parsed.count, 20);
assert.equal(parsed.entityMode, 'company');
assert.equal(parsed.location, 'Pune');
assert.equal(parsed.filters.datePosted, 'past_month');
assert.equal(parsed.filters.postingAgeDays, 30);
assert.equal(parsed.outputMode, 'lead-discovery');
assert.equal(parsed.contactEnrichment, false);
assert.equal(parsed.wantsContacts, false);
assert.equal(parsed.topic, 'SAP consultant');

const hrExample = operator.parseRequest('Find 50 software companies in Kolkata hiring HR executives in the last week. Hybrid or onsite is okay. Fill the sheet.');
assert.equal(hrExample.topic, 'HR executive');
assert.equal(hrExample.companyFilters.industry.toLowerCase(), 'software');
assert.deepEqual(hrExample.filters.preferredWorkplaceTypes, ['hybrid', 'on_site']);
assert.equal(hrExample.filters.workType, null);

const preferred = operator.parseRequest('Find companies hiring AI engineers around Pune, remote preferred.');
assert.deepEqual(preferred.filters.workplaceTypes, []);
assert.deepEqual(preferred.filters.preferredWorkplaceTypes, ['remote']);
assert.equal(preferred.filters.workType, null);
const strict = operator.parseRequest('Find companies hiring AI engineers around Pune, remote only.');
assert.deepEqual(strict.filters.workplaceTypes, ['remote']);
assert.equal(strict.filters.workType, 'remote');

const multi = contract.compile('Find software companies in Mumbai or Pune hiring HR executives in the past week.', {
  entityMode: 'company', count: 50, hiring: true, topic: 'HR', filters: {},
}, { knownLocations: ['Mumbai', 'Pune'] });
assert.deepEqual(multi.hard.locations, ['Mumbai', 'Pune']);
assert.equal(multi.hard.postingAge.maxAgeDays, 7);

const radius = intent.radius('Find AI jobs within 25 km of Bengaluru');
assert.equal(radius.requestedRadiusKm, 25);
assert.equal(radius.maximumRadiusKm, 25);
const widening = intent.radius('Find sales jobs around Mumbai and expand gradually until you reach the target');
assert.equal(widening.expandable, true);
assert.equal(widening.maximumRadiusKm, 100);
const expansionStages = expander.stages('Mumbai', widening);
assert.equal(expansionStages[0].location, 'Mumbai');
assert.ok(expansionStages.some((stage) => stage.location === 'Navi Mumbai' && stage.expanded));
assert.ok(expansionStages.every((stage) => stage.radiusKm <= widening.maximumRadiusKm));

assert.equal(intent.postingAge('posted today').maxAgeDays, 1);
assert.equal(intent.postingAge('posted in the past week').maxAgeDays, 7);
assert.equal(intent.postingAge('posted this month').maxAgeDays, 30);
assert.equal(intent.postingAge('posted in the past 3 days').maxAgeDays, 3);
assert.deepEqual(intent.workplace('remote or hybrid'), { hard: ['remote', 'hybrid'], preferred: [] });
assert.deepEqual(intent.workplace('remote or hybrid preferred'), { hard: [], preferred: ['remote', 'hybrid'] });
assert.equal(intent.applicantFilter('fewer than 100 applicants').max, 100);
assert.equal(intent.postedAgeDays('Posted 8 days ago'), 8);

const rejectedOld = operator.jobLevelFailures({
  hiringVerified: true,
  role: 'AI Engineer',
  jobEvidenceText: 'AI Engineer · Remote · Posted 8 days ago · 30 applicants',
  applicants: '30',
}, {
  hiring: false,
  topic: null,
  filters: { postingAge: intent.postingAge('past week'), workplaceTypes: ['remote'], applicantMax: 100 },
});
assert.ok(rejectedOld.includes('posting_age'));
const rejectedUnknownApplicants = operator.jobLevelFailures({
  hiringVerified: true,
  jobEvidenceText: 'AI Engineer · Remote · Posted today',
  applicants: '',
}, { hiring: false, topic: null, filters: { workplaceTypes: ['remote'], applicantMax: 50 } });
assert.ok(rejectedUnknownApplicants.includes('applicant_count'), 'unknown applicant evidence cannot satisfy a hard applicant cap');

assert.deepEqual(intent.roleVariants('HR'), ['HR Executive', 'HR Recruiter', 'Talent Acquisition', 'Human Resources Specialist']);
assert.ok(intent.roleVariants('AI engineer').includes('Machine Learning Engineer'));
assert.ok(operator.jobSearchPlan(preferred).some((step) => step.workType === null), 'preferred work modes must have a bounded relaxed strategy');
assert.ok(operator.jobSearchPlan(strict).every((step) => step.workType === 'remote'), 'hard work mode must never relax');

const duplicateRecords = operator.dedupeRecords([
  { company: 'Acme', linkedin: 'https://www.linkedin.com/company/acme/', role: 'AI Engineer' },
  { company: 'Acme Ltd', linkedin: 'https://www.linkedin.com/company/acme/', role: 'ML Engineer' },
], 'company');
assert.equal(duplicateRecords.length, 1);

const reordered = ['LOCATION', 'COMPANY LINK', 'COMPANY NAME', 'POC-1', 'PHONE', 'EMAIL'];
assert.deepEqual(operator.ensureHeaders(reordered, parsed, { preserveExisting: true }), reordered);
assert.deepEqual(operator.rowFor({ company: 'Acme', linkedin: 'https://www.linkedin.com/company/acme', location: 'Pune' }, reordered), [
  'Pune', 'https://www.linkedin.com/company/acme', 'Acme', '', '', '',
]);
assert.equal(operator.ensureHeaders([], parsed).some((header) => /phone|email|poc/i.test(header)), false);

const formatted = operator.formatMission({
  request: parsed, requested: 20, found: 20, added: 20, spreadsheetTitle: 'Leads', sheetUrl: 'https://docs.google.com/spreadsheets/d/test',
  averageScore: 90, contactCandidates: 0, duplicateRowsSkipped: 0, toolCalls: {}, filterVerification: null, linkedinSearchWarnings: [],
});
assert.match(formatted, /POC\/contact enrichment: not requested/i);
assert.match(formatted, /Apollo calls: 0/i);

for (const code of [
  'LINKEDIN_BROWSER_BUSY', 'LINKEDIN_COOLDOWN_ACTIVE', 'LINKEDIN_DAILY_CAP', 'LINKEDIN_HOURLY_CAP',
  'LINKEDIN_AUTH_REQUIRED', 'LINKEDIN_CHECKPOINT', 'LINKEDIN_SEARCH_EMPTY', 'LINKEDIN_SEARCH_FAILED',
  'LINKEDIN_PROFILE_UNAVAILABLE', 'LINKEDIN_MCP_UNAVAILABLE', 'GOOGLE_SHEETS_WRITE_FAILED',
  'GOOGLE_SHEETS_READ_FAILED', 'TARGET_NOT_REACHED', 'FILTERS_TOO_RESTRICTIVE', 'LOCATION_EXHAUSTED', 'MISSION_RESUME_REQUIRED',
]) assert.ok(errors.lookup(code)?.title, `${code} must have a human-readable title`);

const operatorSource = fs.readFileSync(path.join(__dirname, '..', 'core', 'linkedin-account-operator.js'), 'utf8');
assert.match(operatorSource, /max_pages:/, 'LinkedIn pagination must remain first-class');
assert.match(operatorSource, /appendRows\([\s\S]*rows/, 'Sheets writes must remain batched');
assert.match(operatorSource, /isTransientMcpFailure/, 'individual browser/query failures must remain contained');
assert.match(operatorSource, /missionRunner\.persistResearch/, 'verified research must be checkpointed before Sheet writes');
assert.doesNotMatch(operatorSource.slice(operatorSource.indexOf('async function companyMission'), operatorSource.indexOf('async function personMission')), /apollo\./i, 'discovery mission must not call Apollo');

console.log('LinkedIn lead discovery benchmark passed: deterministic natural-language intent, hard/preferred filters, radius expansion, posting age, role families, applicant gates, target planning, dedupe, schema mapping, batch-write/checkpoint contracts, safety errors, and zero-Apollo discovery isolation are healthy.');
