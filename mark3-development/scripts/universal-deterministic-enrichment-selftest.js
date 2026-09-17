'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Install the production deterministic wrappers before obtaining schema/ranker refs.
const bootstrap = require('../core/universal-deterministic-bootstrap').install();
const schemaTools = require('../core/universal-sheet-schema');
const planner = require('../core/universal-enrichment-planner');
const ranker = require('../core/universal-authority-ranker');
const profileParser = require('../core/universal-linkedin-profile-parser');

assert.equal(bootstrap.deterministic, true);
assert.equal(bootstrap.modelCalls, 0);

function infer(rows) {
  const schema = schemaTools.inferSchema(rows);
  assert.ok(schema.confidence >= 0.45, `schema confidence too low: ${schema.confidence}`);
  return schema;
}

// 1) Reordered single-contact format. Field order must not be treated as a template.
{
  const rows = [
    ['Business Email', 'LinkedIn Profile', 'Decision Maker Name', 'Mobile Number', 'Designation', 'Employer', 'Requirement'],
    ['alex@northstar.example', 'https://www.linkedin.com/in/alex-example/', 'Alex Example', '+919999999999', 'Talent Acquisition Lead', 'Northstar Technologies', 'Hiring SAP consultants'],
    ['sam@northstar.example', 'https://www.linkedin.com/in/sam-example/', 'Sam Example', '+918888888888', 'Engineering Manager', 'Northstar Technologies', 'Hiring backend engineers'],
  ];
  const schema = infer(rows);
  assert.ok(schema.personGroups.length >= 1, 'reordered contact sheet must contain a person group');
  const fields = schema.personGroups[0].fields;
  assert.ok(fields.name && fields.email && fields.phone && fields.linkedin, 'person fields must be mapped independent of order');
}

// 2) Legacy-style three contacts. Nothing in the universal engine may cap person count at 3.
{
  const rows = [
    ['Primary Contact', 'LinkedIn', 'Phone', 'Email', 'Second Contact', 'Phone 2', 'Email 2', 'Third Contact', 'Phone 3', 'Email 3', 'Job Details'],
    ['A One', 'https://linkedin.com/in/a-one/', '+911111111111', 'a@x.example', 'B Two', '+922222222222', 'b@x.example', 'C Three', '+933333333333', 'c@x.example', 'SAP implementation hiring'],
    ['D Four', 'https://linkedin.com/in/d-four/', '+944444444444', 'd@x.example', 'E Five', '+955555555555', 'e@x.example', 'F Six', '+966666666666', 'f@x.example', 'Cloud engineering hiring'],
  ];
  const schema = infer(rows);
  assert.ok(schema.personGroups.length >= 3, `expected >=3 person groups, got ${schema.personGroups.length}`);
}

// 3) Five contacts with explicit ordinals. Proves arbitrary group count beyond old POC-1/2/3 assumptions.
{
  const header = [];
  const data = [];
  for (let i = 1; i <= 5; i++) {
    header.push(`Contact ${i} Name`, `Contact ${i} Role`, `Contact ${i} Email`, `Contact ${i} Phone`);
    data.push(`Person ${i}`, i === 1 ? 'Recruitment Lead' : `Department Lead ${i}`, `p${i}@example.org`, `+91900000000${i}`);
  }
  const schema = infer([header, data, data.map((value, index) => index % 4 === 0 ? `${value} X` : value)]);
  assert.ok(schema.personGroups.length >= 5, `expected >=5 person groups, got ${schema.personGroups.length}`);
  assert.ok(schema.personGroups.some((group) => Number(group.ordinal) === 5), 'fifth person group must survive schema inference');
}

// 4) Repeated unfamiliar blocks. "Decision Maker" is intentionally not a sacred exact template.
{
  const rows = [
    ['Decision Maker', 'Function', 'Mail', 'Mobile', 'Decision Maker', 'Function', 'Mail', 'Mobile', 'Vacancy Context'],
    ['Aarav Mehta', 'Talent Acquisition', 'aarav@example.com', '+919111111111', 'Mira Shah', 'SAP Delivery', 'mira@example.com', '+919222222222', 'SAP S/4HANA implementation team'],
    ['Kabir Rao', 'Recruiting Operations', 'kabir@example.com', '+919333333333', 'Nisha Jain', 'Engineering Delivery', 'nisha@example.com', '+919444444444', 'Platform engineering team'],
  ];
  const schema = infer(rows);
  assert.ok(schema.personGroups.length >= 2, `repeated structural blocks should recover >=2 people, got ${schema.personGroups.length}`);
  assert.ok(schema.personGroups.filter((group) => group.fields.name).length >= 2, 'both repeated blocks need identity ownership');
}

// 5) Company-only contact format. Generic email/phone belong to the company, not an invented anonymous person.
{
  const rows = [
    ['Organization', 'Website', 'Email', 'Phone', 'City'],
    ['Northstar Technologies', 'https://northstar.example', 'hello@northstar.example', '+911234567890', 'Kolkata'],
    ['Orbit Systems', 'https://orbit.example', 'contact@orbit.example', '+919876543210', 'Bengaluru'],
  ];
  const schema = infer(rows);
  assert.ok(schema.companyGroups.length >= 1, 'company-only sheet must infer a company group');
  const company = schema.companyGroups[0];
  assert.ok(company.fields.email && company.fields.phone, 'generic contact data must attach to strong company identity');
  assert.equal(schema.personGroups.filter((group) => group.fields.email || group.fields.phone).length, 0, 'company-only contacts must not create anonymous person targets');
}

// 6) Planner must understand arbitrary open slots, not fixed first/second/third positions.
{
  const rows = [
    ['Company', 'Contact 1 Name', 'Contact 1 Email', 'Contact 2 Name', 'Contact 2 Email', 'Contact 3 Name', 'Contact 3 Email', 'Contact 4 Name', 'Contact 4 Email'],
    ['Northstar', 'Known Person', 'known@example.com', '', '', '', '', '', ''],
    ['Orbit', 'Other Known', 'other@example.com', '', '', '', '', '', ''],
  ];
  const schema = infer(rows);
  const plan = planner.planRow(rows[1], schema);
  assert.ok(plan.groups.open.length >= 3, `expected at least 3 open contact groups, got ${plan.groups.open.length}`);
}

// 7) Current-employer parser is deterministic and accepts multiple profile response shapes.
{
  const raw = {
    url: 'https://linkedin.com/in/example/',
    sections: {
      main_profile: 'Example Person\nSAP Delivery Manager at Northstar Technologies',
      experience: [
        'SAP Delivery Manager\nNorthstar Technologies Pvt. Ltd. · Full-time\nJan 2025 - Present',
        'Consultant\nOld Systems Ltd\n2022 - 2024',
      ],
    },
  };
  const resolved = profileParser.resolveCurrentEmployer(raw);
  assert.equal(resolved.resolved, true);
  assert.match(resolved.company, /Northstar Technologies/i);
  assert.ok(/explicit-current|current-experience|top-card/i.test(resolved.source));
}

// 8) Context-adaptive ranking. Rich role context can make a functional owner outrank generic recruiting.
{
  const recruiter = {
    id: 'r1', name: 'Recruiter', title: 'Talent Acquisition Specialist', seniority: 'senior',
    functions: ['recruiting'], departments: ['human resources'], organizationName: 'Northstar Technologies',
  };
  const sapOwner = {
    id: 's1', name: 'SAP Owner', title: 'SAP Delivery Head', seniority: 'head',
    functions: ['information technology'], departments: ['engineering'], organizationName: 'Northstar Technologies',
  };
  const genericExec = {
    id: 'e1', name: 'Executive', title: 'Managing Director', seniority: 'c_suite',
    functions: ['executive'], departments: ['executive'], organizationName: 'Northstar Technologies',
  };
  const context = { company: 'Northstar Technologies', details: 'Hiring SAP S/4HANA delivery consultants for implementation and migration projects', companyHeadcount: 700 };
  const ranked = ranker.rankCandidates([recruiter, sapOwner, genericExec], context, { minimumScore: 0 });
  const sap = ranked.ranked.find((item) => item.candidate.id === 's1');
  const exec = ranked.ranked.find((item) => item.candidate.id === 'e1');
  assert.ok(sap, 'SAP functional owner should remain eligible under rich SAP context');
  assert.ok(!exec || sap.score > exec.score, 'large-company generic leadership must not automatically beat role ownership');
  assert.equal(ranked.modelCalls, 0);
  assert.equal(ranked.deterministic, true);
}

// 9) Sparse context should still value explicit hiring-function evidence without a hardcoded title ladder.
{
  const candidates = [
    { id: 'a', name: 'A', title: 'People Acquisition Partner', seniority: 'manager', functions: ['talent acquisition'], departments: ['people'], organizationName: 'Orbit' },
    { id: 'b', name: 'B', title: 'Operations Director', seniority: 'director', functions: ['operations'], departments: ['operations'], organizationName: 'Orbit' },
  ];
  const ranked = ranker.rankCandidates(candidates, { company: 'Orbit' }, { minimumScore: 0 });
  assert.ok(ranked.ranked.length >= 1);
  assert.equal(ranked.ranked[0].candidate.id, 'a', 'explicit hiring-function evidence should dominate unrelated authority when context is sparse');
}

// 10) Static model-free contract for the universal Google-Sheet execution path.
for (const filename of [
  'universal-sheet-enrichment-operator.js',
  'universal-enrichment-engine.js',
  'universal-enrichment-planner.js',
  'universal-sheet-schema.js',
  'universal-schema-hardening.js',
  'universal-schema-proximity-recovery.js',
  'universal-schema-entity-disambiguation.js',
  'universal-authority-ranker.js',
  'universal-adaptive-ranking-policy.js',
  'universal-linkedin-profile-parser.js',
]) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'core', filename), 'utf8');
  assert.doesNotMatch(source, /require\(['"]\.\/model-router['"]\)/, `${filename} must not import model-router`);
  assert.doesNotMatch(source, /chatOmniRouteOnly|modelRouter\.chat|omniRoute\.chat/, `${filename} must not invoke an AI model`);
}

const controllerSource = fs.readFileSync(path.join(__dirname, '..', 'core', 'three-poc-domain-controller.js'), 'utf8');
assert.match(controllerSource, /universal-spreadsheet-domain-controller/);
assert.match(controllerSource, /Google Sheets now go through the deterministic/);

console.log('Universal deterministic enrichment self-test passed: arbitrary contact counts, reordered fields, unfamiliar repeated blocks, company-vs-person ownership, deterministic employer parsing, context-adaptive ranking and zero-model Google-Sheet execution are protected.');
