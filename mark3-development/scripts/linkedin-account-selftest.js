#!/usr/bin/env node
const assert = require('assert');
const operator = require('../core/linkedin-account-operator');
const bootstrap = require('../core/linkedin-account-bootstrap');
const policy = require('../core/linkedin-account-policy');
const mcp = require('../core/linkedin-mcp-client');
const joeyism = require('../core/linkedin-joeyism-bridge');
const sheetOperator = require('../core/google-sheets-operator');
const apollo = require('../core/apollo-enrichment');

assert.equal(operator.isRequest('Find me 50 companies on LinkedIn that are hiring SAP professionals from Maharashtra'), true);
assert.equal(operator.isRequest('Find me 30 SAP recruiters on LinkedIn from Pune'), true);
assert.equal(operator.isRequest('Tell me what LinkedIn is'), false);

const company = operator.parseRequest('Find me 50 companies on LinkedIn that are hiring SAP professionals from Maharashtra');
assert.equal(company.count, 50);
assert.equal(company.entityMode, 'company');
assert.equal(company.location, 'Maharashtra');
assert.equal(company.hiring, true);
assert.equal(company.topic, 'SAP');
assert.equal(company.wantsContacts, true);

const filtered = operator.parseRequest('Find me 20 companies on LinkedIn with SAP roles under 1000 employees, remote, located in Maharashtra');
const exactUserSapRequest = operator.parseRequest('Find me 20 companies on LinkedIn with SAP role openings, under 1000 employees, remote, and located in Maharashtra.');
assert.equal(exactUserSapRequest.topic, 'SAP');
assert.equal(operator.requestTopic('Find me companies on LinkedIn with SAP FICO role openings in Maharashtra', 'company', 'Maharashtra'), 'SAP FICO');
assert.equal(filtered.filters.employeeMax, 1000);
assert.equal(filtered.filters.workType, 'remote');
assert.equal(filtered.filters.datePosted, null);
assert.equal(operator.parseRequest('Find SAP jobs on LinkedIn in Maharashtra remote past month').filters.datePosted, 'past_month');
assert.equal(filtered.location, 'Maharashtra');
assert.equal(filtered.locationScope, 'job');
assert.equal(filtered.topic, 'SAP');
const companyLocationRequest = operator.parseRequest('Find companies on LinkedIn that are based in Maharashtra and hiring SAP');
assert.equal(companyLocationRequest.locationScope, 'company');
const sheetRequest = operator.parseRequest('Find me 20 companies on LinkedIn with SAP role openings, remote, located in Maharashtra and fill https://docs.google.com/spreadsheets/d/testSheet123/edit#gid=987');
assert.equal(sheetRequest.destinationSheetUrl, 'https://docs.google.com/spreadsheets/d/testSheet123/edit#gid=987');
assert.equal(sheetRequest.topic, 'SAP');
assert.equal(sheetOperator.sheetGid(sheetRequest.destinationSheetUrl), 987);
assert.equal(operator.parseCount('Find companies on LinkedIn under 1000 employees'), 25);
assert.equal(operator.parseExplicitCount('Continue and add 20 more companies'), 20);
const naturalJobRequest = operator.parseRequest('Find remote SAP jobs on LinkedIn in Pune');
assert.equal(naturalJobRequest.entityMode, 'company');
assert.equal(naturalJobRequest.hiring, true);
assert.equal(naturalJobRequest.topic, 'SAP');

const person = operator.parseRequest('Find me 30 SAP recruiters on LinkedIn from Pune with email and phone');
assert.equal(person.entityMode, 'person');
assert.equal(person.location, 'Pune');
assert.equal(person.wantsContacts, true);
const personPlan = operator.personSearchPlan(person);
assert.ok(personPlan.some((item) => /SAP recruiter/i.test(item.keyword)));
assert.ok(personPlan.some((item) => /talent acquisition/i.test(item.keyword)));
assert.ok(personPlan.length >= 3);

const exact = operator.parseRequest('Scrape https://www.linkedin.com/company/acme-tech/ on LinkedIn');
assert.equal(exact.entityMode, 'company');
assert.equal(exact.exactUrl, 'https://www.linkedin.com/company/acme-tech');
assert.equal(exact.count, 1);

const companyHeaders = operator.ensureHeaders(operator.COMPANY_HEADERS, company);
assert.deepEqual(companyHeaders, ['NAME', 'COMPANY NAME', 'COMPANY LINK', 'NO. OF APPLICANTS', 'PHONE NUMBER', 'EMAIL', 'REMARKS', 'SAP ROLE', 'JOB LINK', 'LOCATION', 'HIRING SIGNAL']);
assert.equal(operator.headerKey(operator.INTERNAL_CONTACT_HEADER), 'contactLinkedin');
assert.equal(operator.headerKey('NO. OF APPLICANTS'), 'applicants');
assert.equal(operator.headerKey('REMARKS'), 'remarks');
assert.equal(operator.contactRemark('Ashok Singh', 'Director'), 'Ashok Singh (Director)');
assert.equal(operator.contactRemark('Avani Gupta', 'HR Recruiter'), 'Avani Gupta (HR Recruiter)');
assert.equal(operator.applicantCountFromText('Acme · 100+ applicants', 'Acme'), '100+');
assert.deepEqual(operator.jobIdsFromResult({ job_ids: ['4252026496'], url: 'https://www.linkedin.com/jobs/view/sap-consultant-4252026496/' }), ['4252026496']);

const mockJobDetail = {
  sections: { job_posting: 'SAP FICO Consultant\nPune, Maharashtra, India · Remote\nAcme Systems' },
  references: {
    job_posting: [{ kind: 'company', url: '/company/acme-systems/', text: 'Acme Systems', context: 'job posting' }],
  },
};
const mockJobCompanyRefs = operator.linkedInReferences(mockJobDetail, 'company');
assert.equal(mockJobCompanyRefs.length, 1);
assert.equal(mockJobCompanyRefs[0].url, 'https://www.linkedin.com/company/acme-systems');
assert.equal(mockJobCompanyRefs[0].context, 'job posting');
const structuredFallback = operator.joeyismJobToDetail({
  linkedin_url: 'https://www.linkedin.com/jobs/view/4252026496',
  job_title: 'SAP FICO Consultant',
  company: 'Acme Systems',
  company_linkedin_url: 'https://www.linkedin.com/company/acme-systems/',
  location: 'Pune, Maharashtra, India',
  applicant_count: '22 applicants',
  job_description: 'Remote SAP FICO implementation role',
}, '4252026496');
assert.ok(structuredFallback.sections.job_posting.includes('SAP FICO Consultant'));
assert.equal(operator.linkedInReferences(structuredFallback, 'company')[0].url, 'https://www.linkedin.com/company/acme-systems');
assert.ok(operator.joeyismCompanyText({ company_size: '201-500 employees', headquarters: 'Pune, Maharashtra' }).includes('201-500 employees'));

const mockSearchRefs = {
  job_ids: ['4252026496', '4252026500'],
  references: {
    search_results: [
      { kind: 'job', url: '/jobs/view/4252026496/', text: 'SAP FICO Consultant', context: 'job result' },
      { kind: 'job', url: '/jobs/view/4252026500/', text: 'Business Systems Analyst', context: 'job result' },
    ],
  },
};
const searchRefMap = operator.jobReferenceMap(mockSearchRefs);
assert.equal(searchRefMap.get('4252026496').title, 'SAP FICO Consultant');
const priorityMap = new Map([
  ['4252026500', { id: '4252026500', title: 'Business Systems Analyst', hits: 1, locations: ['Maharashtra'], keywords: ['SAP'], bestKeyword: 'SAP', firstRank: 0, firstSeen: 0 }],
  ['4252026496', { id: '4252026496', title: 'SAP FICO Consultant', hits: 1, locations: ['Pune'], keywords: ['SAP FICO'], bestKeyword: 'SAP FICO', firstRank: 1, firstSeen: 1 }],
]);
assert.equal(operator.prioritizedJobIds(priorityMap)[0], '4252026496');
assert.ok(operator.jobIdPriority(priorityMap.get('4252026496')) > operator.jobIdPriority(priorityMap.get('4252026500')));
const trustedPriority = operator.jobIdPriority({ title: 'SAP Consultant', bestKeyword: 'SAP', hits: 1, firstRank: 3, trustedLocations: ['Pune'], trustedWorkTypes: ['remote'] });
const untrustedPriority = operator.jobIdPriority({ title: 'SAP Consultant', bestKeyword: 'SAP', hits: 1, firstRank: 3, trustedLocations: [], trustedWorkTypes: [] });
assert.ok(trustedPriority > untrustedPriority);
const retainedTrust = operator.searchFilterTrust(
  { job_ids: ['4252026496'], sections: { search_results: 'ok' } },
  { keyword: 'SAP', location: 'Pune' },
  filtered
);
assert.equal(retainedTrust.trustedLocation, 'Pune');
assert.equal(retainedTrust.trustedWorkType, 'remote');
const droppedTrust = operator.searchFilterTrust(
  { section_errors: { search_results: { error_type: 'filters_dropped', error_message: 'LinkedIn did not keep location, work type, so the results are broader.' } } },
  { keyword: 'SAP', location: 'Pune' },
  filtered
);
assert.equal(droppedTrust.trustedLocation, '');
assert.equal(droppedTrust.trustedWorkType, '');
assert.ok(operator.droppedSearchFilters({ section_errors: { search_results: { error_type: 'filters_dropped', error_message: 'LinkedIn did not keep location and work type.' } } }).has('location'));
assert.ok(operator.droppedSearchFilters({ section_errors: { search_results: { error_type: 'filters_dropped', error_message: 'LinkedIn did not keep location and work type.' } } }).has('work_type'));
assert.equal(operator.jobTitleFromDetail(mockJobDetail), 'SAP FICO Consultant');
const sapVariants = operator.sapRoleKeywordVariants('SAP');
assert.ok(sapVariants.includes('SAP'));
assert.ok(sapVariants.some((value) => /FICO/.test(value)));
const sapPlan = operator.jobSearchPlan(filtered);
assert.equal(sapPlan.length, 20);
assert.equal(sapPlan[0].keyword, 'SAP');
assert.equal(sapPlan[0].location, 'Maharashtra');
assert.equal(sapPlan[1].location, 'Pune');
assert.equal(sapPlan[2].location, 'Mumbai');
assert.equal(sapPlan[3].location, 'Navi Mumbai');
assert.equal(sapPlan[4].location, 'Thane');
assert.equal(sapPlan[5].location, 'Nagpur');
assert.equal(sapPlan[6].location, 'Nashik');
assert.ok(sapPlan.some((item) => item.keyword === 'SAP FICO'));
assert.ok(sapPlan.some((item) => item.keyword === 'SAP ABAP'));
assert.ok(sapPlan.some((item) => item.keyword === 'SAP Developer'));
assert.ok(sapPlan.some((item) => item.keyword === 'SAP Functional Consultant'));
assert.ok(sapPlan.some((item) => item.keyword === 'SAP BTP'));
assert.ok(sapPlan.some((item) => item.keyword === 'SAP CPI'));
assert.equal(operator.employeeCountFromText('Company size 501-1,000 employees').max, 1000);
assert.equal(operator.passesEmployeeFilter({ employeeCount: { min: 501, max: 1000, openEnded: false } }, filtered.filters), true);
assert.equal(operator.passesEmployeeFilter({ employeeCount: { min: 1000, max: 5000, openEnded: false } }, filtered.filters), false);
const openEndedSize = operator.employeeCountFromText('Company size 1,000+ employees');
assert.equal(openEndedSize.openEnded, true);
assert.equal(openEndedSize.max, null);
assert.equal(operator.passesEmployeeFilter({ employeeCount: openEndedSize }, filtered.filters), false);
assert.equal(operator.passesEmployeeFilter({ employeeCount: null }, filtered.filters), false);

const strictPass = {
  company: 'Acme Maharashtra',
  employeeCount: { min: 201, max: 500, label: '201-500' },
  companyEvidenceText: 'Headquarters Pune, Maharashtra, India. Company size 201-500 employees.',
  jobEvidenceText: 'SAP FICO Consultant · Remote · Maharashtra, India · actively hiring',
  hiringVerified: true,
};
assert.equal(operator.locationEvidenceMatches(strictPass, 'Maharashtra'), true);
assert.equal(operator.workTypeEvidenceMatches(strictPass, 'remote'), true);
assert.equal(operator.topicEvidenceMatches(strictPass, 'SAP'), true);
assert.equal(operator.topicEvidenceMatches(strictPass, 'SAP in .'), true);
assert.deepEqual(operator.companyFilterFailures(strictPass, filtered), []);
assert.equal(operator.passesCompanyHardFilters(strictPass, filtered), true);
assert.deepEqual(operator.jobLevelFailures(strictPass, filtered), []);
assert.deepEqual(operator.companyFilterFailures({ ...strictPass, relevanceScore: 1 }, filtered), []);
assert.equal(operator.detectWorkType('We build hybrid cloud infrastructure. This role is fully remote.'), 'remote');
assert.equal(operator.detectWorkType('Pune, Maharashtra, India · Remote · Full-time'), 'remote');
assert.equal(operator.detectWorkType('We build hybrid cloud infrastructure for enterprises.'), '');

const trustedSearchOnly = {
  company: 'Trusted Search Systems',
  role: 'ABAP Developer',
  employeeCount: { min: 201, max: 500, label: '201-500' },
  jobEvidenceText: 'ABAP Developer\nEnterprise application development',
  hiringVerified: true,
  searchProvenance: {
    title: 'ABAP Developer',
    keywords: ['SAP ABAP'],
    trustedLocations: ['Pune'],
    trustedWorkTypes: ['remote'],
  },
};
assert.equal(operator.topicEvidenceMatches(trustedSearchOnly, 'SAP'), true);
const trustedMmOnly = {
  ...trustedSearchOnly,
  role: 'MM Consultant',
  jobEvidenceText: 'MM Consultant\nProcure-to-pay implementation',
  searchProvenance: {
    title: 'MM Consultant',
    keywords: ['SAP MM'],
    trustedLocations: ['Pune'],
    trustedWorkTypes: ['remote'],
  },
};
assert.equal(operator.topicEvidenceMatches(trustedMmOnly, 'SAP'), true);
assert.equal(operator.locationEvidenceMatches(trustedSearchOnly, 'Maharashtra', { allowJobEvidence: true, allowCompanyEvidence: false }), true);
const conflictingTrustedSearch = {
  ...trustedSearchOnly,
  jobEvidenceText: 'SAP ABAP Developer · Bengaluru, Karnataka, India · Remote',
  searchProvenance: { ...trustedSearchOnly.searchProvenance, trustedLocations: ['Pune'] },
};
const conflictingLocation = operator.locationEvidenceDetails(conflictingTrustedSearch, 'Maharashtra', { allowJobEvidence: true, allowCompanyEvidence: false });
assert.equal(conflictingLocation.matched, false);
assert.equal(conflictingLocation.source, 'job_conflict');
assert.equal(operator.workTypeEvidenceMatches(trustedSearchOnly, 'remote'), true);
assert.deepEqual(operator.jobLevelFailures(trustedSearchOnly, filtered), []);
assert.equal(operator.workTypeEvidenceDetails(trustedSearchOnly, 'remote').source, 'linkedin_search_filter');
const hiringIndependentOfTopic = { ...strictPass, hiringVerified: true, jobEvidenceText: 'Oracle Cloud Consultant · Remote · Maharashtra, India' };
assert.ok(operator.jobLevelFailures(hiringIndependentOfTopic, filtered).includes('topic'));
assert.ok(!operator.jobLevelFailures(hiringIndependentOfTopic, filtered).includes('hiring'));

const remoteMaharashtraJobFromKarnatakaCompany = { ...strictPass, companyEvidenceText: 'Headquarters Bengaluru, Karnataka, India.' };
assert.equal(operator.locationEvidenceMatches(remoteMaharashtraJobFromKarnatakaCompany, 'Maharashtra', { allowJobEvidence: true }), true);
assert.equal(operator.passesCompanyHardFilters(remoteMaharashtraJobFromKarnatakaCompany, filtered), true);

const wrongState = {
  ...strictPass,
  companyEvidenceText: 'Headquarters Bengaluru, Karnataka, India.',
  jobEvidenceText: 'SAP FICO Consultant · Remote · Bengaluru, Karnataka · actively hiring',
};
assert.ok(operator.companyFilterFailures(wrongState, filtered).includes('location'));

const hybridOnly = { ...strictPass, jobEvidenceText: 'SAP FICO Consultant · Hybrid · Pune, Maharashtra' };
assert.ok(operator.companyFilterFailures(hybridOnly, filtered).includes('work_type'));
assert.ok(operator.jobLevelFailures(hybridOnly, filtered).includes('work_type'));

const noEmployeeProof = { ...strictPass, employeeCount: null };
assert.ok(operator.companyFilterFailures(noEmployeeProof, filtered).includes('employee_count'));

const wrongTopic = { ...strictPass, jobEvidenceText: 'Oracle Cloud Consultant · Remote · Maharashtra, India' };
assert.ok(operator.companyFilterFailures(wrongTopic, filtered).includes('topic'));

const rejectedSnapshot = operator.rejectedRecordSnapshot(
  { ...wrongTopic, linkedin: 'https://www.linkedin.com/company/acme-maharashtra' },
  ['topic'],
  filtered
);
assert.equal(rejectedSnapshot.company, 'Acme Maharashtra');
assert.equal(rejectedSnapshot.workType, 'remote');
assert.deepEqual(rejectedSnapshot.rejectionReasons, ['topic']);
assert.ok(operator.rejectedSheetHeaders().includes('REJECTION REASONS'));
assert.equal(operator.rejectedSheetRow(rejectedSnapshot)[0], 'Acme Maharashtra');
assert.equal(operator.isRejectedSheetRequest('Make a sheet of the rejected candidates'), true);

const dynamicHeaders = operator.ensureHeaders(operator.COMPANY_HEADERS, filtered);
assert.ok(dynamicHeaders.includes('LOCATION'));
assert.ok(dynamicHeaders.includes('WORK TYPE'));
assert.ok(dynamicHeaders.includes('EMPLOYEES'));
assert.ok(dynamicHeaders.includes('HIRING SIGNAL'));
assert.equal(operator.headerKey('Business Name'), 'company');
assert.equal(operator.headerKey('Job Opening Link'), 'jobLink');
assert.equal(operator.headerKey('Work Mode'), 'workType');
const customHeader = operator.destinationHeaderCandidate([
  ['notes only'],
  ['Business Name', 'Company Profile', 'Job Opening Link', 'Work Mode'],
]);
assert.equal(customHeader.rowNumber, 2);
const destinationKeys = operator.destinationExistingKeys({
  headerRowNumber: 1,
  rows: [
    ['Business Name', 'Company Profile', 'Job Opening Link'],
    ['Acme', 'https://www.linkedin.com/company/acme', 'https://www.linkedin.com/jobs/view/4252026496'],
  ],
}, ['Business Name', 'Company Profile', 'Job Opening Link']);
assert.ok(destinationKeys.has('linkedin:https://www.linkedin.com/company/acme'));
assert.ok(destinationKeys.has('job:https://www.linkedin.com/jobs/view/4252026496'));
assert.ok(operator.recordDestinationKeys({ company: 'Acme', linkedin: 'https://www.linkedin.com/company/acme' }).includes('company:acme'));
const verifiedSnapshot = operator.verifiedRecordSnapshot({
  company: 'Acme',
  role: 'SAP FICO Consultant',
  linkedin: 'https://www.linkedin.com/company/acme',
  jobUrl: 'https://www.linkedin.com/jobs/view/4252026496',
  employeeCount: { min: 201, max: 500, label: '201-500' },
});
assert.equal(verifiedSnapshot.company, 'Acme');
assert.equal(verifiedSnapshot.role, 'SAP FICO Consultant');
assert.equal(typeof operator.fillLatestMissionIntoSheet, 'function');
assert.equal(typeof operator.isExistingSheetFillRequest, 'function');
assert.equal(typeof operator.workspaceSheetUrl, 'function');
assert.equal(typeof operator.prepareContinuation, 'function');
assert.equal(typeof operator.consolidateVerifiedMissions, 'function');
assert.equal(typeof operator.dedupeWorkspaceSheet, 'function');
assert.equal(operator.isConsolidateRequest('Consolidate all LinkedIn company results into one sheet'), true);
assert.equal(operator.isDedupeSheetRequest('Dedupe the current LinkedIn sheet'), true);
assert.equal(
  operator.criteriaSignature(filtered),
  operator.criteriaSignature({ ...filtered, count: 99, destinationSheetUrl: 'https://docs.google.com/spreadsheets/d/ignored/edit' })
);
assert.equal(
  operator.consolidatedRecordKey({ linkedin: 'https://www.linkedin.com/company/acme', company: 'Acme' }),
  'linkedin:https://www.linkedin.com/company/acme'
);

const storageHeaders = [...operator.COMPANY_HEADERS, operator.INTERNAL_CONTACT_HEADER];
const storageRow = operator.rowFor({
  name: 'Asha Singh', role: 'Director', company: 'Acme', linkedin: 'https://www.linkedin.com/company/acme',
  applicants: '100+', phone: '', email: '', contactLinkedin: 'https://www.linkedin.com/in/asha-singh',
}, storageHeaders);
assert.deepEqual(storageRow.slice(0, 7), ['Asha Singh', 'Acme', 'https://www.linkedin.com/company/acme', '100+', '', '', 'Asha Singh (Director)']);
const detected = sheetOperator.detectLayout([storageHeaders, storageRow]);
assert.equal(detected.linkedinColumn, 'H');
assert.equal(detected.phoneColumn, 'E');
assert.equal(detected.emailColumn, 'F');

assert.equal(bootstrap.isStatusRequest('LinkedIn account status'), true);
assert.equal(bootstrap.isSetupRequest('LinkedIn account login'), true);
assert.equal(bootstrap.isUnlockRequest('LinkedIn account unlock'), true);

assert.equal(mcp.HOST, '127.0.0.1');
assert.ok(mcp.ENDPOINT.startsWith('http://127.0.0.1:'));
assert.ok(mcp.serverArgs().includes('--no-auto-import'));
assert.ok(mcp.serverArgs().includes('127.0.0.1'));

assert.ok(policy.READ_ONLY_TOOLS.has('search_people'));
assert.ok(policy.READ_ONLY_TOOLS.has('search_companies'));
assert.ok(policy.READ_ONLY_TOOLS.has('search_jobs'));
assert.ok(policy.READ_ONLY_TOOLS.has('get_person_profile'));
assert.throws(() => policy.assertReadOnlyTool('send_message'), /disabled|allowlist/i);
assert.throws(() => policy.assertReadOnlyTool('connect_with_person'), /disabled|allowlist/i);

const limits = policy.settings();
assert.equal(typeof limits.localBudgetBypass, 'boolean');
const previousBudgetBypass = process.env.ULTRON_M3_LINKEDIN_TEST_BYPASS_LOCAL_BUDGET;
process.env.ULTRON_M3_LINKEDIN_TEST_BYPASS_LOCAL_BUDGET = '1';
assert.equal(policy.settings().localBudgetBypass, true);
assert.ok(policy.settings().testMissionToolMax >= 120);
assert.ok(policy.settings().testJobSearchMax >= 20);
if (previousBudgetBypass == null) delete process.env.ULTRON_M3_LINKEDIN_TEST_BYPASS_LOCAL_BUDGET;
else process.env.ULTRON_M3_LINKEDIN_TEST_BYPASS_LOCAL_BUDGET = previousBudgetBypass;
assert.ok(limits.minGapMs >= 5000);
assert.ok(limits.burstMax <= 12);
assert.ok(limits.hourlyMax <= 30);
assert.ok(limits.dailyMax <= 120);
assert.ok(limits.missionToolMax <= limits.hourlyMax);
assert.ok(limits.deepProfilesPerMission <= 12);
assert.ok(limits.maxJobPages <= 5);

assert.equal(joeyism.equivalentTool('person'), 'get_person_profile');
assert.equal(joeyism.equivalentTool('company'), 'get_company_profile');
assert.equal(joeyism.equivalentTool('job'), 'get_job_details');
assert.equal(joeyism.equivalentTool('jobs'), 'search_jobs');
assert.equal(apollo.decisionPriority('Head of Talent Acquisition', 'hiring'), 1);
assert.equal(apollo.decisionPriority('Talent Acquisition Manager', 'hiring'), 2);
assert.equal(apollo.decisionPriority('Technical Recruiter', 'hiring'), 3);
assert.ok(apollo.decisionPriority('Founder', 'hiring') > apollo.decisionPriority('Head of Talent Acquisition', 'hiring'));

const parsed = mcp.parsePayload('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n');
assert.equal(parsed.result.ok, true);
const normalized = mcp.normalizeToolResult({ content: [{ type: 'text', text: '{"sections":{"main":"hello"}}' }] });
assert.equal(normalized.sections.main, 'hello');

const lock = policy.classifyError(new Error('LinkedIn security checkpoint detected'));
assert.equal(lock.kind, 'manual-lock');
const rate = policy.classifyError(new Error('429 Too Many Requests'));
assert.equal(rate.kind, 'rate-limit');
const strikeNow = Date.now();
const strikeState = { events: [{ at: strikeNow, errorKind: 'rate-limit' }, { at: strikeNow - 1000, errorKind: 'rate-limit' }] };
assert.equal(policy.recentRateLimitStrikes(strikeState, strikeNow), 2);
assert.equal(policy.adaptiveRateLimitCooldownMs(strikeState, strikeNow), Math.min(6 * 60 * 60 * 1000, limits.rateLimitCooldownMs * 2));

console.log('LinkedIn account integration self-test passed. Dedicated routing, company-profile links, strict location/work-type/headcount/topic gates, rejected-candidate persistence/export, temporary local-budget test bypass, canonical SAP topic parsing, 20-query target-driven SAP discovery, trusted retained-filter evidence with explicit-conflict precedence, strict company-size ranges, resumable criteria, persistent Sheet workspace, consolidation/dedupe/reuse, structured joeyism job/company recovery, target-driven people/recruiter research, adaptive SAP role/city discovery, criteria-only hard gates, bullet-safe workplace parsing, job-first hiring linkage, evidence columns, hiring-aware Apollo preparation, hidden person linkage, bounded LinkedIn calls, adaptive cooldowns, read-only enforcement and checkpoint circuit breaking are structurally healthy.');
