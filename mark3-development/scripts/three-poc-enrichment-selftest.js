const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const three = require('../core/three-poc-enrichment-operator');
const bootstrap = require('../core/lead-enrichment-bootstrap');

const legacy = [[
  'Person or Company Name','L','Post Details','L','Linkedin Id','Phone no','Email ID',
  '2nd POC Name','Phone no','Email ID','3rd POC','Phone no','Email ID','Call Outcome','Remarks','Demos'
]];
const legacyLayout = three.detectThreePocLayout(legacy);
assert.equal(legacyLayout.first.nameIndex, 0);
assert.equal(legacyLayout.first.phoneIndex, 5);
assert.equal(legacyLayout.first.emailIndex, 6);
assert.equal(legacyLayout.second.nameIndex, 7);
assert.equal(legacyLayout.second.phoneIndex, 8);
assert.equal(legacyLayout.second.emailIndex, 9);
assert.equal(legacyLayout.third.nameIndex, 10);
assert.equal(legacyLayout.third.phoneIndex, 11);
assert.equal(legacyLayout.third.emailIndex, 12);

const explicit = [[
  'Company Name','Post Details','LinkedIn Id',
  '1st POC Name','Phone','Email',
  '2nd POC Name','Phone','Email',
  '3rd POC Name','Phone','Email','Remarks'
]];
const explicitLayout = three.detectThreePocLayout(explicit);
assert.equal(explicitLayout.companyIndex, 0);
assert.equal(explicitLayout.first.nameIndex, 3);
assert.equal(explicitLayout.second.nameIndex, 6);
assert.equal(explicitLayout.third.nameIndex, 9);

const candidates = [
  { candidateKey: 'a', name: 'A' },
  { candidateKey: 'b', name: 'B' },
  { candidateKey: 'c', name: 'C' },
];
assert.deepEqual(
  three.validKeys({ pocs: [
    { candidateKey: 'b', reason: 'x', confidence: 0.8 },
    { candidateKey: 'b', reason: 'duplicate', confidence: 0.9 },
    { candidateKey: 'unknown', reason: 'bad', confidence: 1 },
    { candidateKey: 'a', reason: 'y', confidence: 0.7 },
  ]}, candidates, 3).map(x => x.candidateKey),
  ['b','a']
);
assert.equal(three.displayName({ name: 'Jane Doe', title: 'Head of Talent' }), 'Jane Doe — Head of Talent');

const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'three-poc-enrichment-operator.js'), 'utf8');
assert.ok(!source.includes('decisionPriority('), '3-POC operator must not use hardcoded decisionPriority');
assert.ok(!source.includes('COMPANY_DECISION_PRIORITY'), '3-POC operator must not use hardcoded COMPANY_DECISION_PRIORITY');
assert.match(source, /Hiring-Authority Selector/);
assert.match(source, /Independent Hiring-Responsibility Reviewer/);
assert.match(source, /Contact-data availability must NOT influence responsibility ranking/);

console.log('Agentic 3-POC enrichment self-test passed. Layout mapping is safe and hiring-responsibility ranking remains AI-agent driven.');

const request = bootstrap.isThreePocRequest(
  'Fill 1st POC, 2nd POC and 3rd POC with the most responsible people for hiring in @New_Sheet_14-09-25',
  { attachments: [{ id: 'file-test-1', name: 'New_Sheet_14-09-25.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }] }
);
assert.ok(request);
assert.equal(request.provider, 'local-excel');
assert.equal(request.url, 'vault:file-test-1');
