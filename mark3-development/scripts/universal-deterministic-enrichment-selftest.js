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
const operator = require('../core/universal-sheet-enrichment-operator');

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

// 8) Company-contact ranking must honor the canonical lead priority while remaining deterministic.
{
  const founder = {
    id: 'f1', name: 'Founder', title: 'Founder & Director', seniority: 'owner',
    functions: ['executive'], departments: ['executive'], organizationName: 'Northstar Technologies',
  };
  const recruitingManager = {
    id: 'm1', name: 'Manager', title: 'Talent Acquisition Manager', seniority: 'manager',
    functions: ['talent acquisition'], departments: ['human resources'], organizationName: 'Northstar Technologies',
  };
  const recruiter = {
    id: 'r1', name: 'Recruiter', title: 'Technical Recruiter', seniority: 'senior',
    functions: ['recruiting'], departments: ['human resources'], organizationName: 'Northstar Technologies',
  };
  const sapOwner = {
    id: 's1', name: 'SAP Owner', title: 'SAP Delivery Head', seniority: 'head',
    functions: ['information technology'], departments: ['engineering'], organizationName: 'Northstar Technologies',
  };
  const context = { company: 'Northstar Technologies', details: 'Hiring SAP S/4HANA delivery consultants for implementation and migration projects', companyHeadcount: 700 };
  const ranked = ranker.rankCandidates([recruiter, sapOwner, founder, recruitingManager], context, { minimumScore: 0 });
  const ids = ranked.ranked.map((item) => item.candidate.id);
  assert.ok(ids.includes('f1'), 'founder/director must remain eligible');
  assert.ok(ids.includes('m1'), 'TA/HR manager must remain eligible');
  assert.ok(ids.includes('r1'), 'ordinary recruiter must remain eligible even when Apollo structured metadata is sparse');
  assert.ok(ids.indexOf('f1') < ids.indexOf('m1'), 'Founder/Director/Owner must outrank recruiting/HR manager');
  assert.ok(ids.indexOf('m1') < ids.indexOf('r1'), 'recruiting/HR manager must outrank recruiter/TA specialist');
  assert.equal(ranked.modelCalls, 0);
  assert.equal(ranked.deterministic, true);
}

// 9) A recruiter title alone is sufficient to enter the candidate pool; contextual evidence still breaks ties.
{
  const candidates = [
    { id: 'a', name: 'A', title: 'Recruiter', organizationName: 'Orbit' },
    { id: 'b', name: 'B', title: 'SAP Delivery Head', seniority: 'head', functions: ['information technology'], organizationName: 'Orbit' },
  ];
  const ranked = ranker.rankCandidates(candidates, { company: 'Orbit', details: 'Hiring SAP consultants' }, { minimumScore: 0 });
  assert.ok(ranked.ranked.some((item) => item.candidate.id === 'a'), 'plain recruiter must not fall through the hiringAuthority eligibility gap');
  assert.ok(ranked.ranked.length >= 2, 'functional owner may remain available as a lower-priority/contextual candidate');
}

// 10) Broad and title-targeted discovery pools must merge without duplicate hydration candidates.
{
  const merged = operator.mergeCandidatePools(
    [
      { id: '1', name: 'Founder', title: 'Founder' },
      { id: '2', name: 'Engineer', title: 'Engineer' },
    ],
    [
      { id: '1', name: 'Founder', title: 'Founder' },
      { id: '3', name: 'Recruiter', title: 'Technical Recruiter' },
    ],
  );
  assert.deepEqual(merged.map((item) => item.id), ['1', '2', '3']);
  const priorityTitles = operator.companyPriorityTitles().map((value) => String(value).toLowerCase());
  assert.ok(priorityTitles.includes('founder'));
  assert.ok(priorityTitles.includes('recruiter'));
  assert.equal(operator.companyPriorityCandidate({ title: 'Technical Recruiter' }), true);
  assert.equal(operator.companyPriorityCandidate({ title: 'Software Engineer' }), false);
}

// 11) Primary, bounded AI rescue and legacy Big Pickle fallback must share
// discovery evidence instead of repeating Apollo searches. Empty-slot selection is
// intentionally deferred to the bounded AI rescue when it is enabled.
{
  const targetedSource = fs.readFileSync(path.join(__dirname, '..', 'core', 'universal-sheet-enrichment-targeted.js'), 'utf8');
  const fallbackSource = fs.readFileSync(path.join(__dirname, '..', 'core', 'universal-big-pickle-fallback-pass.js'), 'utf8');
  const aiSource = fs.readFileSync(path.join(__dirname, '..', 'core', 'universal-ai-batch-rescue.js'), 'utf8');
  assert.match(targetedSource, /sharedDiscoveryCache/);
  assert.match(targetedSource, /deferOpenGroupSelectionToAi:\s*boundedAiEnabled/);
  assert.match(targetedSource, /aiBatchRescue\.run\(exact\.request, primary, runOptions\)/);
  assert.match(targetedSource, /exactRowLastResort\(exact\.request, primary, runOptions\)/);
  assert.match(targetedSource, /const discoveryCache=options\.discoveryCache instanceof Map\?options\.discoveryCache:new Map\(\)/);
  assert.match(aiSource, /options\.discoveryCache instanceof Map \? options\.discoveryCache : new Map\(\)/);
  const operatorSource = fs.readFileSync(path.join(__dirname, '..', 'core', 'universal-sheet-enrichment-operator.js'), 'utf8');
  assert.match(fallbackSource, /options\.discoveryCache instanceof Map \? options\.discoveryCache : new Map\(\)/);
  assert.match(operatorSource, /deferOpenGroupSelectionToAi/);
}

// 12) Static model-free contract for the universal Google-Sheet execution path.
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

// Controller invariants must be structural, not tied to comments/prose.
const controllerSource = fs.readFileSync(path.join(__dirname, '..', 'core', 'three-poc-domain-controller.js'), 'utf8');
assert.match(controllerSource, /require\(['"]\.\/universal-deterministic-bootstrap['"]\)\.install\(\)/, 'deterministic policies must install before Google Sheet dispatch');
assert.match(controllerSource, /const universalController = require\(['"]\.\/universal-spreadsheet-domain-controller['"]\)/, 'controller must load universal spreadsheet owner');
assert.match(controllerSource, /if \(sheets\.extractSheetUrl\(original\) \|\| sheets\.extractSheetUrl\(message\)\) \{\s*return universalController\.handle\(message, context\);\s*\}/, 'Google Sheet requests must dispatch directly to the universal controller');
assert.match(controllerSource, /function installLegacyExcelWrappers\(\)/, 'legacy AI wrappers must remain isolated behind a lazy compatibility installer');
const googleDispatchIndex = controllerSource.indexOf('return universalController.handle(message, context);');
const legacyInstallIndex = controllerSource.indexOf('installLegacyExcelWrappers();');
assert.ok(googleDispatchIndex >= 0, 'universal Google dispatch must exist');
assert.ok(legacyInstallIndex > googleDispatchIndex, 'legacy AI wrappers must install only after the Google Sheet early-return path');

console.log('Universal deterministic enrichment self-test passed: arbitrary contact counts, reordered fields, unfamiliar repeated blocks, company-vs-person ownership, deterministic employer parsing, canonical company-contact priority and the model-free safety/write layer are protected; unresolved empty-slot selection may now be deferred to the separately bounded AI rescue.');
