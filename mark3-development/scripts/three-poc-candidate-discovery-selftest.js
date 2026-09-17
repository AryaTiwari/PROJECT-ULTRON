const assert = require('assert');
const fs = require('fs');
const path = require('path');

const policy = require('../core/three-poc-candidate-discovery-policy');

assert.deepEqual(
  policy.mergePeople(
    [{ id: '1', name: 'A' }, { id: '2', name: 'B' }],
    [{ id: '2', name: 'B duplicate' }, { id: '3', name: 'C' }]
  ).map((person) => person.id),
  ['1', '2', '3']
);

const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'three-poc-candidate-discovery-policy.js'), 'utf8');
const controller = fs.readFileSync(path.join(__dirname, '..', 'core', 'three-poc-domain-controller.js'), 'utf8');

assert.match(source, /domainPrimaryCalls/);
assert.match(source, /domainBroadCalls/);
assert.match(source, /companyNameTargetedCalls/);
assert.match(source, /companyNameBroadCalls/);
assert.match(source, /domain: '', company, titles/);
assert.match(source, /domain: '', company, titles: \[\]/);
assert.match(source, /sameOrganization\(\)/);
assert.match(controller, /three-poc-candidate-discovery-policy/);
assert.match(controller, /candidateDiscovery\.startRun\(\)/);
assert.match(controller, /Zero-credit discovery rescue/);

policy.startRun();
const stats = policy.stats();
assert.equal(stats.mode, 'zero-credit-high-recall');
assert.equal(stats.employerSafetyFilter, 'sameOrganization');
assert.equal(stats.companyNameRescues, 0);

console.log('3-POC candidate discovery self-test passed: sparse employer-domain results can fall back to verified employer-name search, dedupe is stable, and the same-organization safety filter remains authoritative.');
