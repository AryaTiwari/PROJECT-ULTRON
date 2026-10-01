#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const targeted = require('../core/universal-sheet-enrichment-targeted');
const controller = require('../core/universal-spreadsheet-domain-controller');

const merged = targeted.mergePocPhaseResults([
  {
    sheetName: 'Arya 2',
    contactPhaseOrdinal: 1,
    contactPhaseLabel: 'POC-1',
    completedFully: true,
    partialCompletion: false,
    stats: {
      contactPhaseOrdinal: 1,
      contactPhaseLabel: 'POC-1',
      rowsSeen: 15,
      rowsProcessed: 15,
      rowsChanged: 3,
      cellsChanged: 5,
      newPeopleSelected: 0,
      existingGroupsRepaired: 2,
      unfilledOpenGroups: 0,
      discoveryDiagnostics: [],
      leftoverQueue: [],
      deferredPoc2Rows: [],
    },
  },
  {
    sheetName: 'Arya 2',
    contactPhaseOrdinal: 2,
    contactPhaseLabel: 'POC-2',
    completedFully: true,
    partialCompletion: false,
    stats: {
      contactPhaseOrdinal: 2,
      contactPhaseLabel: 'POC-2',
      rowsSeen: 15,
      rowsProcessed: 15,
      rowsChanged: 4,
      cellsChanged: 12,
      newPeopleSelected: 4,
      existingGroupsRepaired: 1,
      unfilledOpenGroups: 1,
      deferredOpenGroups: 1,
      deferredPoc2Rows: [5],
      discoveryDiagnostics: [{ rowNumber: 5, groupOrdinal: 2, code: 'POC2_TEST' }],
      leftoverQueue: [{ rowNumber: 5, groupOrdinal: 2, code: 'POC2_NO_DISCOVERY_CANDIDATES' }],
    },
  },
  {
    sheetName: 'Arya 2',
    contactPhaseOrdinal: 3,
    contactPhaseLabel: 'POC-3',
    completedFully: true,
    partialCompletion: false,
    stats: {
      contactPhaseOrdinal: 3,
      contactPhaseLabel: 'POC-3',
      rowsSeen: 15,
      rowsProcessed: 15,
      rowsChanged: 2,
      cellsChanged: 6,
      newPeopleSelected: 2,
      existingGroupsRepaired: 0,
      unfilledOpenGroups: 3,
      discoveryDiagnostics: [],
      leftoverQueue: [],
      deferredPoc2Rows: [],
    },
  },
]);

assert.equal(merged.stats.cellsChanged, 23);
assert.equal(merged.stats.rowsChanged, 9);
assert.equal(merged.stats.newPeopleSelected, 6);
assert.deepEqual(merged.stats.deferredPoc2Rows, [5]);
assert.equal(merged.stats.pocPhaseSummaries.length, 3);
assert.deepEqual(merged.stats.pocPhaseSummaries.map((item) => item.ordinal), [1, 2, 3]);
assert.equal(merged.stats.contactPhaseLabel, 'FAST ALL -> DEEP POC-1 -> DEEP POC-2');
assert.equal(merged.stats.unfilledOpenGroups, 4);

// Regression: company-led D:F / G:I layout must not lose a blank POC-1
// merely because POC-2 already has a verified name/email and a pending phone.
// These are synthetic rows; no Apollo calls or Google Sheet writes occur here.
const liveSchema = { personGroups: [
  { id: 'poc-1', kind: 'person', ordinal: 1, fields: {
    name: { index: 3 }, email: { index: 4 }, phone: { index: 5 },
  }},
  { id: 'poc-2', kind: 'person', ordinal: 2, fields: {
    name: { index: 6 }, email: { index: 7 }, phone: { index: 8 },
  }},
]};
const liveRowPlans = [
  { rowNumber: 2, row: ['Example A','','','','','','Verified POC-2','two@example.com',''] },
  { rowNumber: 3, row: ['Example B','','','Verified POC-1','one@example.com','+919876543210','','',''] },
  { rowNumber: 4, row: ['Example C','','','','','','Another POC-2','second@example.com',''] },
];
const pendingForPoc2Only = new Set(['2:2','4:2']);
assert.deepEqual(
  targeted.livePocGapRows(liveRowPlans, liveSchema, 1, {}, pendingForPoc2Only),
  [2, 4],
  'pending POC-2 ownership must not mask the blank POC-1 in the same company row',
);
assert.deepEqual(
  targeted.livePocGapRows(liveRowPlans, liveSchema, 2, {}, pendingForPoc2Only),
  [3],
  'do not repeat paid POC-2 discovery while exact callbacks are pending',
);
assert.deepEqual(
  targeted.livePocGapRows(liveRowPlans, liveSchema, 1, { targetRows: [4] }, pendingForPoc2Only),
  [4],
  'explicit row scope must remain authoritative',
);


// Regression: a company LinkedIn column before POC-1 must not become POC-1's
// personal LinkedIn. This was the root cause of a real 42-company worksheet
// enriching G:I while leaving much of D:F untouched.
const schemaTools = require('../core/universal-sheet-schema');
const planner = require('../core/universal-enrichment-planner');
const companyLedRows = [
  ['Company Name','Roles','Linkedin','1st Poc','Email','Phone','2nd POC','Email','Phone','Call Outcome','Remarks'],
  ['Acme One','Tech','https://www.linkedin.com/company/acme-one/','','','','Existing Recruiter','recruiter@acme-one.in','','',''],
  ['Acme Two','Tech','https://www.linkedin.com/company/acme-two/','','','','Other Recruiter','recruiter@acme-two.in','','',''],
  ['Acme Three','Tech','Open on LinkedIn','','','','Third Recruiter','recruiter@acme-three.in','','',''],
];
const inferredCompanyLed = schemaTools.inferSchema(companyLedRows);
assert.equal(inferredCompanyLed.personGroups.length, 2, 'retain both real person groups');
assert.equal(inferredCompanyLed.companyGroups.length, 1, 'company name and its link must share one entity');
assert.equal(inferredCompanyLed.personGroups[0].fields.name.index, 3);
assert.equal(inferredCompanyLed.personGroups[0].fields.linkedin, undefined,
  'column C is company evidence, not a POC-1 identity');
assert.equal(inferredCompanyLed.companyGroups[0].fields.linkedin.index, 2);
const companyPlan = planner.planRow(companyLedRows[1], inferredCompanyLed);
assert.equal(companyPlan.anchor.type, 'company');
assert.equal(companyPlan.anchor.group.kind, 'company');
assert.ok(require('../core/universal-sheet-enrichment-operator').candidateFillTargets(companyPlan)
  .some((item) => item.group.ordinal === 1), 'empty D:F must enter POC-1 discovery');

assert.equal(controller.parseContactPhaseOrdinal('Fill POC-1 only in Arya 2'), 1);
assert.equal(controller.parseContactPhaseOrdinal('Only second POC for this sheet'), 2);
assert.equal(controller.parseContactPhaseOrdinal('3rd POC only'), 3);
assert.equal(controller.parseContactPhaseOrdinal('Fill POC-1 then POC-2 then POC-3'), null);
assert.equal(
  controller.parseContactPhaseOrdinal('POC-2 identity discovery should be necessary only where F is actually blank.'),
  null,
  '"only where" must not activate POC-2-only diagnostic mode',
);
assert.equal(
  controller.parseContactPhaseOrdinal('POC-3 identity discovery should be necessary only where I is actually blank.'),
  null,
  '"only where" must not activate POC-3-only diagnostic mode',
);
assert.equal(
  controller.parseContactPhaseOrdinal('Enrich POC-1, POC-2 and POC-3 together. POC-2 discovery is necessary only where F is blank and POC-3 discovery only where I is blank.'),
  null,
  'all-POC production wording must remain coordinated mode',
);


const operator = require('../core/universal-sheet-enrichment-operator');
const identitySnapshot = {
  values: {
    name: 'Ashraf Saggaf — Director of Talent & Culture',
    linkedin: '',
    email: '',
    phone: '',
  },
};
const verifiedExisting = {
  identityVerified: true,
  noMatch: false,
  ambiguous: false,
  name: 'Ashraf Saggaf',
  title: 'Director of Talent & Culture',
  organizationName: 'Different Existing Employer',
  email: 'ashraf@example.com',
};
assert.equal(
  operator.existingIdentityVerified(
    identitySnapshot,
    verifiedExisting,
    { company: 'Bright Vision Technologies', domain: '' },
    'public-index-exact',
  ),
  true,
  'exact existing identity + compatible embedded role must permit contact completion even when row employer context differs',
);
assert.equal(
  operator.existingIdentityVerified(
    identitySnapshot,
    { ...verifiedExisting, title: 'Software Engineer' },
    { company: 'Bright Vision Technologies', domain: '' },
    'public-index-exact',
  ),
  false,
  'name-only public-index match with incompatible role must not unlock contact writes',
);

const root = path.join(__dirname, '..', 'core');
const operatorSource = fs.readFileSync(path.join(root, 'universal-sheet-enrichment-operator.js'), 'utf8');
const targetedSource = fs.readFileSync(path.join(root, 'universal-sheet-enrichment-targeted.js'), 'utf8');
const controllerSource = fs.readFileSync(path.join(root, 'universal-spreadsheet-domain-controller.js'), 'utf8');

assert.match(operatorSource, /contactPhaseOrdinal/);
assert.match(operatorSource, /phaseOrdinal === 1/);
assert.match(operatorSource, /phaseOrdinal === 2/);
assert.match(operatorSource, /phaseOrdinal === 3/);
assert.match(operatorSource, /const discoveryTargets = phaseOrdinal === 3[\s\S]*?openPersonTargets/);
assert.match(operatorSource, /targetOrdinals: phaseOrdinals/);

assert.match(targetedSource, /const phasedExecution = options\.pocPhasePipeline === true \|\| Boolean\(options\.contactPhaseOrdinal\)/);
assert.match(targetedSource, /async function runPocPhasePipeline/);
assert.match(targetedSource, /timed\('fast-all'/);
assert.match(targetedSource, /deferDeterministicRecheck: true/);
assert.match(targetedSource, /for \(const ordinal of ordinals\)/);
assert.match(targetedSource, /timed\(`deep-poc-\$\{ordinal\}`/);
assert.ok(targetedSource.indexOf("timed('fast-all'") < targetedSource.indexOf('for (const ordinal of ordinals)'), 'the sheet-wide easy pass must finish before ordered deep revision');
assert.match(operatorSource, /maxNewHydrations/);
assert.match(operatorSource, /candidateHydrationConcurrency/);
assert.match(operatorSource, /!options\.deferDeterministicRecheck/);
assert.match(targetedSource, /\? await runPocPhasePipeline\(exact\.request, runOptions\)/);
assert.match(targetedSource, /: await base\.run\(exact\.request, runOptions\)/);
assert.match(targetedSource, /POC-phase pipeline:/);
assert.match(targetedSource, /poc-phase-deterministic-only/);
assert.match(targetedSource, /const phaseOrdinal = Number\(options\.contactPhaseOrdinal \|\| 0\) \|\| null/);
assert.match(targetedSource, /\(!phaseOrdinal \|\| phaseOrdinal === 1\)/);
assert.match(targetedSource, /\(!phaseOrdinal \|\| phaseOrdinal === 2\)/);
assert.match(controllerSource, /writes easy verified results across the whole sheet first/);
assert.match(controllerSource, /deeply revises unresolved POC-1 rows from top to bottom/);
assert.doesNotMatch(targetedSource, /const boundedAiEnabled = aiBatchRescue\.enabled\(\) && options\.apolloApproved/);

console.log('Universal POC phase pipeline self-test passed: enrichment writes a sheet-wide fast pass first, then deeply revises unresolved POC-1 before POC-2, uses bounded concurrent hydration waves, and aggregate reporting preserves final residue.');
