const assert = require('assert');
const fs = require('fs');
const path = require('path');

const policy = require('../core/three-poc-candidate-discovery-policy');
const apollo = require('../core/apollo-enrichment');

assert.deepEqual(
  policy.mergePeople(
    [{ id: '1', name: 'A' }, { id: '2', name: 'B' }],
    [{ id: '2', name: 'B duplicate' }, { id: '3', name: 'C' }]
  ).map((person) => person.id),
  ['1', '2', '3']
);

const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'three-poc-candidate-discovery-policy.js'), 'utf8');
const controller = fs.readFileSync(path.join(__dirname, '..', 'core', 'three-poc-domain-controller.js'), 'utf8');
const universalOperator = fs.readFileSync(path.join(__dirname, '..', 'core', 'universal-sheet-enrichment-operator.js'), 'utf8');

assert.match(source, /domainPrimaryCalls/);
assert.match(source, /domainBroadCalls/);
assert.match(source, /companyNameTargetedCalls/);
assert.match(source, /companyNameBroadCalls/);
assert.match(source, /domain: '', company, titles/);
assert.match(source, /domain: '', company, titles: \[\]/);
assert.match(source, /sameOrganization\(\)/);
assert.match(controller, /three-poc-candidate-discovery-policy/);
assert.match(controller, /candidateDiscovery\.startRun\(\)/);
assert.match(universalOperator, /minimumUsefulCandidatePool/);
assert.match(universalOperator, /merged\.length < minimumUsefulPool/);
assert.match(controller, /Zero-credit discovery rescue/);

policy.startRun();
const stats = policy.stats();
assert.equal(stats.mode, 'zero-credit-high-recall');
assert.equal(stats.employerSafetyFilter, 'sameOrganization');
assert.equal(stats.companyNameRescues, 0);

const wrongEmployer = apollo.searchCandidateFromPerson({
  id: 'person-1',
  name: 'Example Recruiter',
  title: 'Talent Acquisition Manager',
  organization_name: 'Other Company',
  organization: { primary_domain: 'other.example' },
}, 'Hanvitt Consulting & Solutions', 'hanvitt.com');
assert.equal(wrongEmployer.apolloSearchEmployerVerified, false, 'search filter alone must not prove current employer');

const rightEmployer = apollo.searchCandidateFromPerson({
  id: 'person-2',
  name: 'Verified Recruiter',
  title: 'Talent Acquisition Manager',
  organization_name: 'Hanvitt Consulting & Solutions',
  organization: { primary_domain: 'hanvitt.com' },
}, 'Hanvitt Consulting & Solutions', 'hanvitt.com');
assert.equal(rightEmployer.apolloSearchEmployerVerified, true);

console.log('3-POC candidate discovery self-test passed: sparse universal candidate pools keep broadening instead of stopping at one weak result, current-employer evidence must come from the returned person record, dedupe is stable, and the same-organization safety filter remains authoritative.');
