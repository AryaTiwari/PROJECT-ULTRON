const assert = require('assert');
const fs = require('fs');
const path = require('path');

const savedAllow = process.env.ULTRON_M3_PROVIDER_ALLOWLIST;
const savedDeny = process.env.ULTRON_M3_PROVIDER_DENYLIST;
delete process.env.ULTRON_M3_PROVIDER_ALLOWLIST;
delete process.env.ULTRON_M3_PROVIDER_DENYLIST;

const diversity = require('../core/three-poc-omniroute-diversity');

assert.equal(diversity.laneFrom([{ role: 'system', content: 'You are ULTRON Hiring-Authority Selector.' }]), 'selector');
assert.equal(diversity.laneFrom([{ role: 'system', content: 'You are ULTRON Independent Hiring-Responsibility Reviewer.' }]), 'reviewer');
assert.equal(diversity.laneFrom([{ role: 'system', content: 'You are ULTRON Exact LinkedIn Employer Resolver.' }]), 'employer');
assert.equal(diversity.laneFrom([{ role: 'system', content: 'You are ULTRON Profile Employer Normalizer.' }]), 'profile-normalizer');

assert.equal(diversity.usableConcreteModel('auto/best-reasoning'), false);
assert.equal(diversity.usableConcreteModel('openai/gpt-5.6-mini'), true);
assert.equal(diversity.usableConcreteModel('gemini/gemini-3.6-flash'), true);
assert.ok(diversity.researchScore('anthropic/claude-4-sonnet', 'research') > diversity.researchScore('some-provider/tiny-lite', 'research'));
assert.equal(diversity.routeFamilyMatches('gemini', 'gemini/gemini-3.6-flash'), true);
assert.equal(diversity.routeFamilyMatches('vertex', 'gemini/gemini-3.6-flash'), false,
  'a Vertex route resolving to Gemini is not genuine model-family diversity');
assert.equal(diversity.routeFamilyMatches('zenmux', 'gemini/gemini-3.6-flash'), false,
  'an aggregator route resolving to Gemini must be reported as a route-family mismatch');

if (savedAllow == null) delete process.env.ULTRON_M3_PROVIDER_ALLOWLIST;
else process.env.ULTRON_M3_PROVIDER_ALLOWLIST = savedAllow;
if (savedDeny == null) delete process.env.ULTRON_M3_PROVIDER_DENYLIST;
else process.env.ULTRON_M3_PROVIDER_DENYLIST = savedDeny;

const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'three-poc-omniroute-diversity.js'), 'utf8');
const controller = fs.readFileSync(path.join(__dirname, '..', 'core', 'three-poc-domain-controller.js'), 'utf8');
assert.match(source, /omniRoute\.listModels/);
assert.match(source, /omniRoute\.chat/);
assert.doesNotMatch(source, /require\(['"]\.\/direct-provider-router['"]\)/);
assert.doesNotMatch(source, /direct\.chat\s*\(/);
assert.match(source, /personalApiFallbackAllowed:false/);
assert.match(source, /routeFamilyMismatches/);
assert.match(source, /effectiveProviderPool/);
assert.match(source, /ROUTE_FAMILY_MISMATCH/);
assert.match(source, /laneCursor/);
assert.match(controller, /three-poc-omniroute-diversity/);

console.log('3-POC OmniRoute diversity self-test passed: advertised route labels must match the returned concrete model family, fake diversity is rejected, and the workflow remains OmniRoute-only.');
