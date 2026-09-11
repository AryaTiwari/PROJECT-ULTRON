#!/usr/bin/env node
const assert = require('assert');
const operator = require('../core/linkedin-account-operator');
const bootstrap = require('../core/linkedin-account-bootstrap');
const policy = require('../core/linkedin-account-policy');
const mcp = require('../core/linkedin-mcp-client');
const joeyism = require('../core/linkedin-joeyism-bridge');
const sheetOperator = require('../core/google-sheets-operator');

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
assert.equal(filtered.filters.employeeMax, 1000);
assert.equal(filtered.filters.workType, 'remote');
assert.equal(filtered.location, 'Maharashtra');
assert.equal(filtered.topic, 'SAP');
assert.equal(operator.parseCount('Find companies on LinkedIn under 1000 employees'), 25);

const person = operator.parseRequest('Find me 30 SAP recruiters on LinkedIn from Pune with email and phone');
assert.equal(person.entityMode, 'person');
assert.equal(person.location, 'Pune');
assert.equal(person.wantsContacts, true);

const exact = operator.parseRequest('Scrape https://www.linkedin.com/company/acme-tech/ on LinkedIn');
assert.equal(exact.entityMode, 'company');
assert.equal(exact.exactUrl, 'https://www.linkedin.com/company/acme-tech');
assert.equal(exact.count, 1);

const companyHeaders = operator.ensureHeaders(operator.COMPANY_HEADERS, company);
assert.deepEqual(companyHeaders, ['NAME', 'COMPANY NAME', 'COMPANY LINK', 'NO. OF APPLICANTS', 'PHONE NUMBER', 'EMAIL', 'REMARKS']);
assert.equal(operator.headerKey(operator.INTERNAL_CONTACT_HEADER), 'contactLinkedin');
assert.equal(operator.headerKey('NO. OF APPLICANTS'), 'applicants');
assert.equal(operator.headerKey('REMARKS'), 'remarks');
assert.equal(operator.contactRemark('Ashok Singh', 'Director'), 'Ashok Singh (Director)');
assert.equal(operator.contactRemark('Avani Gupta', 'HR Recruiter'), 'Avani Gupta (HR Recruiter)');
assert.equal(operator.applicantCountFromText('Acme · 100+ applicants', 'Acme'), '100+');
assert.deepEqual(operator.jobIdsFromResult({ job_ids: ['4252026496'], url: 'https://www.linkedin.com/jobs/view/sap-consultant-4252026496/' }), ['4252026496']);
assert.equal(operator.employeeCountFromText('Company size 501-1,000 employees').max, 1000);
assert.equal(operator.passesEmployeeFilter({ employeeCount: { min: 501, max: 1000 } }, filtered.filters), true);
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
assert.deepEqual(operator.companyFilterFailures(strictPass, filtered), []);
assert.equal(operator.passesCompanyHardFilters(strictPass, filtered), true);

const wrongState = { ...strictPass, companyEvidenceText: 'Headquarters Bengaluru, Karnataka, India.' };
assert.ok(operator.companyFilterFailures(wrongState, filtered).includes('location'));

const hybridOnly = { ...strictPass, jobEvidenceText: 'SAP FICO Consultant · Hybrid · Pune, Maharashtra' };
assert.ok(operator.companyFilterFailures(hybridOnly, filtered).includes('work_type'));

const noEmployeeProof = { ...strictPass, employeeCount: null };
assert.ok(operator.companyFilterFailures(noEmployeeProof, filtered).includes('employee_count'));

const wrongTopic = { ...strictPass, jobEvidenceText: 'Oracle Cloud Consultant · Remote · Maharashtra, India' };
assert.ok(operator.companyFilterFailures(wrongTopic, filtered).includes('topic'));

const dynamicHeaders = operator.ensureHeaders(operator.COMPANY_HEADERS, filtered);
assert.ok(dynamicHeaders.includes('LOCATION'));
assert.ok(dynamicHeaders.includes('WORK TYPE'));
assert.ok(dynamicHeaders.includes('EMPLOYEES'));
assert.ok(dynamicHeaders.includes('HIRING SIGNAL'));

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
assert.ok(limits.minGapMs >= 5000);
assert.ok(limits.burstMax <= 12);
assert.ok(limits.hourlyMax <= 30);
assert.ok(limits.dailyMax <= 120);
assert.ok(limits.missionToolMax <= limits.hourlyMax);
assert.ok(limits.deepProfilesPerMission <= 12);
assert.ok(limits.maxJobPages <= 3);

assert.equal(joeyism.equivalentTool('person'), 'get_person_profile');
assert.equal(joeyism.equivalentTool('company'), 'get_company_profile');
assert.equal(joeyism.equivalentTool('jobs'), 'search_jobs');

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

console.log('LinkedIn account integration self-test passed. Dedicated routing, company-profile links, strict location/work-type/headcount/topic gates, evidence columns, Apollo-first company-head preparation, hidden person linkage, bounded LinkedIn calls, adaptive cooldowns, read-only enforcement and checkpoint circuit breaking are structurally healthy.');
