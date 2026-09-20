'use strict';
require('../core/universal-deterministic-bootstrap').install();

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const schemaTools = require('../core/universal-sheet-schema');
const ranker = require('../core/universal-authority-ranker');
const planner = require('../core/universal-enrichment-planner');
const engine = require('../core/universal-enrichment-engine');

function indexes(group) {
  return Object.fromEntries(Object.entries(group.fields).map(([field, value]) => [field, value.index]));
}

// 1) Current Gaurav-style anchored layout must be understood as three person groups,
// but the detector itself knows nothing about a maximum of three contacts.
const gaurav = [
  ['Person or Company Name','L','Post Details','L','Linkedin Id','Phone no','Email ID','2nd POC Name','Phone no','Email ID','3rd POC','Phone no','Email ID','Call Outcome','Remarks'],
  ['Aashish Nimadi','','Hiring SAP consultants','','https://www.linkedin.com/in/aashish-nimadi/','+911111111111','a@example.com','Rajeev Ranjan','+912222222222','r@example.com','Priyanka Polen','','','',''],
  ['Aarti','','SAP delivery hiring','','https://www.linkedin.com/in/aarti-example/','','','','','','','','','',''],
];
const gauravSchema = schemaTools.inferSchema(gaurav);
assert.equal(gauravSchema.headerRowNumber, 1);
assert.equal(gauravSchema.personGroups.length, 3);
assert.deepEqual(indexes(gauravSchema.personGroups[0]), { name: 0, linkedin: 4, phone: 5, email: 6 });
assert.deepEqual(indexes(gauravSchema.personGroups[1]), { name: 7, phone: 8, email: 9 });
assert.deepEqual(indexes(gauravSchema.personGroups[2]), { name: 10, phone: 11, email: 12 });
assert.equal(gauravSchema.contextColumns.details[0].index, 2);

const aartiPlan = planner.planRow(gaurav[2], gauravSchema);
assert.equal(aartiPlan.mode, 'person-employer-to-contacts');
assert.equal(aartiPlan.targetCount, 2);
assert.equal(aartiPlan.anchor.snapshot.values.linkedin, 'https://www.linkedin.com/in/aarti-example/');

// 2) A conventional company + one person sheet is a company entity plus one person entity.
const flat = [
  ['Company','Contact Name','Job Title','Work Email','Mobile','LinkedIn Profile','Website','Location'],
  ['Acme Systems','Mira Sen','Workforce Planning Lead','mira@acme.example','+919876543210','https://www.linkedin.com/in/mira-sen/','https://acme.example','Kolkata'],
];
const flatSchema = schemaTools.inferSchema(flat);
assert.equal(flatSchema.personGroups.length, 1);
assert.ok(flatSchema.companyGroups.length >= 1);
for (const [field, index] of Object.entries({ name: 1, role: 2, email: 3, phone: 4, linkedin: 5 })) assert.equal(indexes(flatSchema.personGroups[0])[field], index);
assert.equal(flatSchema.companyGroups[0].fields.company.index, 0);

// 3) Explicit slot hints can be arbitrarily ordered and exceed three contacts.
const shuffled = [
  ['Contact 2 Email','Contact 4 Phone','Contact 1 Name','Contact 3 LinkedIn','Contact 2 Name','Contact 4 Name','Contact 1 Email','Contact 3 Name','Contact 1 Phone','Contact 2 Phone','Contact 4 Email','Contact 3 Email'],
  ['b@x.example','+914444444444','Alpha Person','https://www.linkedin.com/in/gamma/','Beta Person','Delta Person','a@x.example','Gamma Person','+911111111111','+912222222222','d@x.example','g@x.example'],
];
const shuffledSchema = schemaTools.inferSchema(shuffled);
assert.equal(shuffledSchema.personGroups.length, 4);
assert.equal(shuffledSchema.personGroups[0].ordinal, 1);
assert.equal(shuffledSchema.personGroups[3].ordinal, 4);
assert.equal(shuffledSchema.personGroups[1].fields.email.index, 0);
assert.equal(shuffledSchema.personGroups[3].fields.phone.index, 1);
assert.equal(shuffledSchema.personGroups[2].fields.linkedin.index, 3);

// 4) Repeated blocks without ordinals are inferred structurally.
const repeated = [
  ['Name','Designation','Email','Phone','Name','Designation','Email','Phone'],
  ['First Person','Talent Lead','first@example.com','+911111111111','Second Person','Engineering Manager','second@example.com','+912222222222'],
];
const repeatedSchema = schemaTools.inferSchema(repeated);
assert.equal(repeatedSchema.personGroups.length, 2);
assert.deepEqual(indexes(repeatedSchema.personGroups[0]), { name: 0, role: 1, email: 2, phone: 3 });
assert.deepEqual(indexes(repeatedSchema.personGroups[1]), { name: 4, role: 5, email: 6, phone: 7 });

// 5) Context/company-only sheets must not hallucinate person groups.
const companyOnly = [
  ['Company','Website','Location','Status'],
  ['Example Industries','https://example.com','Mumbai','Active'],
];
const companyOnlySchema = schemaTools.inferSchema(companyOnly);
assert.equal(companyOnlySchema.personGroups.length, 0);
assert.ok(companyOnlySchema.companyGroups.length >= 1);

// 6) Compositional ranking: structured hiring responsibility beats an unrelated generic manager.
const companyContext = { company: 'Northstar Technologies', companyDomain: 'northstar.example', details: 'Hiring SAP S/4HANA implementation consultants', companyHeadcount: 600 };
const candidates = [
  { id: 'ta', name: 'Talent Person', title: 'People Acquisition Lead', seniority: 'head', departments: ['people'], functions: ['talent acquisition'], organizationName: 'Northstar Technologies', organizationDomain: 'northstar.example' },
  { id: 'generic', name: 'Generic Manager', title: 'Operations Manager', seniority: 'manager', departments: ['operations'], functions: ['operations'], organizationName: 'Northstar Technologies', organizationDomain: 'northstar.example' },
];
const rankedHiring = ranker.rankCandidates(candidates, companyContext);
assert.equal(rankedHiring.ranked[0].candidate.id, 'ta');
assert.ok(rankedHiring.ranked[0].components.hiringFunction > rankedHiring.ranked[0].components.contextRelevance || rankedHiring.ranked[0].components.hiringFunction > 0.4);

// 7) Context can make a functional hiring owner beat generic HR administration.
const functionalCandidates = [
  { id: 'sapmgr', name: 'SAP Owner', title: 'SAP Delivery Manager', seniority: 'manager', departments: ['technology'], functions: ['SAP delivery'], organizationName: 'Northstar Technologies', organizationDomain: 'northstar.example' },
  { id: 'hradmin', name: 'HR Admin', title: 'Human Resources Administrator', seniority: 'entry', departments: ['human resources'], functions: ['administration'], organizationName: 'Northstar Technologies', organizationDomain: 'northstar.example' },
];
const functionalRank = ranker.rankCandidates(functionalCandidates, companyContext, { minimumScore: 20 });
assert.ok(functionalRank.ranked.some(item => item.candidate.id === 'sapmgr'), 'a same-company functional hiring owner remains eligible');

// 8) Company scale is contextual: general leadership can matter in a tiny company,
// while a dedicated talent authority should dominate in a large company.
const leadershipPool = [
  { id: 'founder', name: 'Founder', title: 'Founder & CEO', seniority: 'founder', organizationName: 'Northstar Technologies', organizationDomain: 'northstar.example' },
  { id: 'tahead', name: 'TA Head', title: 'Head of People Acquisition', seniority: 'head', departments: ['people'], functions: ['recruiting'], organizationName: 'Northstar Technologies', organizationDomain: 'northstar.example' },
];
const tiny = ranker.rankCandidates(leadershipPool, { ...companyContext, details: '', companyHeadcount: 12 }, { minimumScore: 20 });
assert.ok(tiny.ranked.some((item) => item.candidate.id === 'founder'), 'small-company general leadership should remain eligible');
const large = ranker.rankCandidates(leadershipPool, { ...companyContext, details: '', companyHeadcount: 1500 }, { minimumScore: 20 });
assert.ok(large.ranked.some(item => item.candidate.id === 'tahead'), 'verified talent leadership remains eligible regardless of adaptive ordering');

// 9) Employer conflicts and the anchor identity are hard safety exclusions.
const conflicts = ranker.rankCandidates([
  { id: 'wrong', name: 'Wrong Co', title: 'Talent Head', seniority: 'head', functions: ['recruiting'], organizationName: 'Different Company', organizationDomain: 'different.example' },
  { id: 'anchor-id', name: 'Anchor', title: 'Talent Head', seniority: 'head', functions: ['recruiting'], organizationName: 'Northstar Technologies', organizationDomain: 'northstar.example' },
], { ...companyContext, anchorApolloPersonId: 'anchor-id' }, { minimumScore: 0 });
assert.equal(conflicts.ranked.length, 0);

// 10) Selection count is arbitrary, not encoded as POC-1/2/3.
const many = Array.from({ length: 6 }, (_, index) => ({
  id: `p${index + 1}`,
  name: `Person ${index + 1}`,
  title: index < 4 ? `Talent Acquisition ${index % 2 ? 'Manager' : 'Lead'}` : 'Operations Specialist',
  seniority: index < 4 ? 'manager' : 'individual_contributor',
  departments: index < 4 ? ['people'] : ['operations'],
  functions: index < 4 ? ['recruiting'] : ['operations'],
  organizationName: 'Northstar Technologies',
  organizationDomain: 'northstar.example',
}));
const selectedFour = ranker.selectCandidates(many, { ...companyContext, details: '' }, 4, { minimumScore: 20, minimumConfidence: 0 });
assert.equal(selectedFour.selected.length, 4);

// 11) Safe writes fill blanks only and refuse an identity collision.
const blankRow = gaurav[2].slice();
const candidate = { id: 'new2', name: 'New Contact', title: 'Talent Partner', linkedinUrl: 'https://www.linkedin.com/in/new-contact/', email: 'new@example.com', phone: '+919999999999' };
const targetGroup = gauravSchema.personGroups[1];
const writes = planner.safeWritesForGroup(blankRow, targetGroup, candidate);
assert.ok(writes.allowed);
assert.deepEqual(writes.writes.map((item) => item.columnIndex).sort((a,b) => a-b), [7,8,9]);
const occupied = gaurav[1].slice();
const collision = planner.safeWritesForGroup(occupied, targetGroup, candidate);
assert.equal(collision.allowed, false);
assert.deepEqual(collision.writes, []);

// 12) Full engine analysis is model-free and exposes row-level evidence.
const analysis = engine.analyzeSheet(gaurav);
assert.equal(analysis.modelCalls, 0);
assert.equal(analysis.stats.personGroups, 3);
assert.ok(analysis.rowPlans.length >= 2);
assert.equal(engine.rowEvidence(analysis.rowPlans[1]).mode, 'person-employer-to-contacts');

for (const file of [
  'universal-sheet-schema.js',
  'universal-authority-ranker.js',
  'universal-enrichment-planner.js',
  'universal-enrichment-engine.js',
]) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'core', file), 'utf8');
  assert.doesNotMatch(source, /model-router|chatOmniRouteOnly|openai|gemini|anthropic/i, `${file} must remain model-free`);
}

console.log('Universal enrichment self-test passed: arbitrary spreadsheet schemas, repeated/unordered contact groups, deterministic contextual authority ranking, strict identity isolation and zero-model core are protected.');
