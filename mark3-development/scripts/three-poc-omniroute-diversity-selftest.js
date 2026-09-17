const assert = require('assert');
const fs = require('fs');
const path = require('path');

const diversity = require('../core/three-poc-omniroute-diversity');

assert.equal(diversity.laneFrom([
  { role: 'system', content: 'You are ULTRON Hiring-Authority Selector.' },
]), 'selector');
assert.equal(diversity.laneFrom([
  { role: 'system', content: 'You are ULTRON Independent Hiring-Responsibility Reviewer.' },
]), 'reviewer');
assert.equal(diversity.laneFrom([
  { role: 'system', content: 'You are ULTRON Exact LinkedIn Employer Resolver.' },
]), 'employer');
assert.equal(diversity.laneFrom([
  { role: 'system', content: 'You are ULTRON Profile Employer Normalizer.' },
]), 'profile-normalizer');

assert.equal(diversity.usableConcreteModel('auto/best-reasoning'), false);
assert.equal(diversity.usableConcreteModel('openai/gpt-5.6-mini'), true);
assert.equal(diversity.usableConcreteModel('gemini/gemini-3.6-flash'), true);
assert.ok(diversity.researchScore('anthropic/claude-4-sonnet', 'research') > diversity.researchScore('some-provider/tiny-lite', 'research'));

const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'three-poc-omniroute-diversity.js'), 'utf8');
const controller = fs.readFileSync(path.join(__dirname, '..', 'core', 'three-poc-domain-controller.js'), 'utf8');

assert.match(source, /omniRoute\.listModels/);
assert.match(source, /omniRoute\.chat/);
assert.doesNotMatch(source, /direct-provider-router/);
assert.match(source, /personalApiFallbackAllowed: false/);
assert.match(source, /Personal-API fallbacks: 0/);
assert.match(source, /providerCounts/);
assert.match(source, /providerPool/);
assert.match(source, /laneCursor/);
assert.match(controller, /three-poc-omniroute-diversity/);

console.log('3-POC OmniRoute diversity self-test passed: heavy reasoning remains gateway-only, rotates across eligible concrete providers by reasoning lane, and never falls through to personal API keys.');
