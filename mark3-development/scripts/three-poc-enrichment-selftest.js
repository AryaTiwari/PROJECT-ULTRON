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
assert.equal(legacyLayout.schema, 'anchored_first_poc');
assert.equal(legacyLayout.first.nameIndex, 0);
assert.equal(legacyLayout.first.phoneIndex, 5);
assert.equal(legacyLayout.first.emailIndex, 6);
assert.equal(legacyLayout.first.linkedinIndex, 4);
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
  '3rd POC Name','Phone','Email','Remarks',
  '1st POC LinkedIn','2nd POC LinkedIn','3rd POC LinkedIn'
]];
const explicitLayout = three.detectThreePocLayout(explicit);
assert.equal(explicitLayout.schema, 'explicit_three_poc');
assert.equal(explicitLayout.companyIndex, 0);
assert.equal(explicitLayout.first.nameIndex, 3);
assert.equal(explicitLayout.second.nameIndex, 6);
assert.equal(explicitLayout.third.nameIndex, 9);
assert.equal(explicitLayout.first.linkedinIndex, 13);
assert.equal(explicitLayout.second.linkedinIndex, 14);
assert.equal(explicitLayout.third.linkedinIndex, 15);

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
assert.equal(three.linkedInProfileKind('ID: https://www.linkedin.com/in/aashish-nimadi-2678a6413/'), 'person');
assert.equal(three.linkedInProfileKind('https://www.linkedin.com/company/allegisit/'), 'company');
assert.equal(three.personNameKey('Rajeev Ranjan — Recruitment Manager'), 'rajeev ranjan');
assert.equal(three.personNameKey('Divya Pandey (Sr. IT Recruiter)'), 'divya pandey');

const matchCandidates = [
  { candidateKey: 'r', name: 'Rajeev Ranjan', title: 'Recruitment Manager' },
  { candidateKey: 'p', name: 'Priyanka Polen', title: 'Recruiter' },
];
assert.equal(three.matchExistingCandidate('Rajeev Ranjan', matchCandidates).candidateKey, 'r');
assert.equal(three.matchExistingCandidate('Unknown Human', matchCandidates), null);

const anchoredChanges = three.anchoredRowChanges(
  'Gaurav 2',
  3,
  legacyLayout,
  { phone: '+911111111111', email: 'anchor@example.com' },
  [
    { name: 'Rajeev Ranjan', title: 'Recruitment Manager', phone: '+912222222222', email: 'rajeev@example.com' },
    { name: 'Priyanka Polen', title: 'Recruiter', phone: '+913333333333', email: 'priyanka@example.com' },
  ],
  [false, false],
);
const anchoredCells = anchoredChanges.map((change) => change.range.split('!').pop().replace(/\$/g, ''));
assert.deepEqual(anchoredCells, ['F3','G3','H3','I3','J3','K3','L3','M3']);
assert.ok(!anchoredCells.includes('A3'), 'anchored flow must never overwrite POC-1 name');
assert.ok(!anchoredCells.includes('E3'), 'anchored flow must never overwrite POC-1 LinkedIn');

const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'three-poc-enrichment-operator.js'), 'utf8');
assert.ok(!source.includes('decisionPriority('), '3-POC operator must not use hardcoded decisionPriority');
assert.ok(!source.includes('COMPANY_DECISION_PRIORITY'), '3-POC operator must not use hardcoded COMPANY_DECISION_PRIORITY');
assert.match(source, /Hiring-Authority Selector/);
assert.match(source, /Independent Hiring-Responsibility Reviewer/);
assert.match(source, /Contact-data availability must NOT influence responsibility ranking/);
assert.match(source, /anchored_first_poc/);
assert.match(source, /resolvePersonProfile/);
assert.match(source, /Exact POC-1 LinkedIn profile -> current Apollo organization/);
assert.match(source, /if \(layout\.schema === 'anchored_first_poc'\) return \[\];/);

console.log('Agentic 3-POC enrichment self-test passed. Explicit and anchored legacy layouts are isolated; POC-1 identity/employer anchoring and POC-2/POC-3 slot ordering are protected.');

const request = bootstrap.isThreePocRequest(
  'Fill 1st POC, 2nd POC and 3rd POC with the most responsible people for hiring in @New_Sheet_14-09-25',
  { attachments: [{ id: 'file-test-1', name: 'New_Sheet_14-09-25.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }] }
);
assert.ok(request);
assert.equal(request.provider, 'local-excel');
assert.equal(request.url, 'vault:file-test-1');

const naturalRequest = bootstrap.isThreePocRequest(
  'do the 2nd POC name with designation and 3rd POC name with designation, with respective LinkedIn, person phone and email in @New_Sheet_14-09-25',
  { attachments: [{ id: 'file-test-1', name: 'New_Sheet_14-09-25.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }] }
);
assert.ok(naturalRequest, 'Natural 2nd/3rd POC contact wording should route to the 3-POC operator');

const anchoredNaturalRequest = bootstrap.isThreePocRequest(
  [
    'Use @New_Sheet_14-09-25 and perform the Mark 3 anchored 3-POC enrichment.',
    'Person or Company Name = POC-1 name.',
    'LinkedIn Id = POC-1 person LinkedIn profile.',
    '2nd POC Name has its own phone and email.',
    '3rd POC has its own phone and email.',
    'Resolve POC-1 current employer, preserve POC-1, and enrich POC-2 and POC-3 respectively.',
  ].join(' '),
  { attachments: [{ id: 'file-test-1', name: 'New_Sheet_14-09-25.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }] }
);
assert.ok(anchoredNaturalRequest, 'Anchored POC-1/POC-2/POC-3 wording must route to the local 3-POC operator');
assert.equal(anchoredNaturalRequest.provider, 'local-excel');
