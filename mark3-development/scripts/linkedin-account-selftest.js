#!/usr/bin/env node
const assert = require('assert');
const operator = require('../core/linkedin-account-operator');
const bootstrap = require('../core/linkedin-account-bootstrap');
const policy = require('../core/linkedin-account-policy');
const mcp = require('../core/linkedin-mcp-client');
const joeyism = require('../core/linkedin-joeyism-bridge');

assert.equal(operator.isRequest('Find me 50 companies on LinkedIn that are hiring SAP professionals from Maharashtra'), true);
assert.equal(operator.isRequest('Find me 30 SAP recruiters on LinkedIn from Pune'), true);
assert.equal(operator.isRequest('Tell me what LinkedIn is'), false);

const company = operator.parseRequest('Find me 50 companies on LinkedIn that are hiring SAP professionals from Maharashtra');
assert.equal(company.count, 50);
assert.equal(company.entityMode, 'company');
assert.equal(company.location, 'Maharashtra');
assert.equal(company.hiring, true);
assert.equal(company.topic, 'SAP');

const person = operator.parseRequest('Find me 30 SAP recruiters on LinkedIn from Pune with email and phone');
assert.equal(person.entityMode, 'person');
assert.equal(person.location, 'Pune');
assert.equal(person.wantsContacts, true);

const exact = operator.parseRequest('Scrape https://www.linkedin.com/company/acme-tech/ on LinkedIn');
assert.equal(exact.entityMode, 'company');
assert.equal(exact.exactUrl, 'https://www.linkedin.com/company/acme-tech');
assert.equal(exact.count, 1);

const companyHeaders = operator.ensureHeaders(['Company', 'LinkedIn Company URL'], company);
assert.ok(companyHeaders.includes('Company'));
assert.ok(companyHeaders.includes('LinkedIn Company URL'));
assert.ok(companyHeaders.includes('Hiring Signal'));
assert.ok(companyHeaders.includes('Source'));
assert.ok(companyHeaders.includes('Lead Score'));

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
assert.ok(limits.hourlyMax <= 30);
assert.ok(limits.dailyMax <= 120);
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

console.log('LinkedIn account integration self-test passed. Explicit LinkedIn routing, company/person parsing, loopback-only MCP configuration, read-only tool allowlist, account cooldown limits, checkpoint circuit breaker and optional joeyism fallback wiring are structurally healthy.');
