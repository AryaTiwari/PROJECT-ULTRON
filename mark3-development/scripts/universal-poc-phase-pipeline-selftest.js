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
assert.equal(merged.stats.contactPhaseLabel, 'POC-1 -> POC-2 -> POC-3');
assert.equal(merged.stats.unfilledOpenGroups, 4);

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

assert.match(operatorSource, /contactPhaseOrdinal/);
assert.match(operatorSource, /phaseOrdinal === 1/);
assert.match(operatorSource, /phaseOrdinal === 2/);
assert.match(operatorSource, /phaseOrdinal === 3/);
assert.match(operatorSource, /const discoveryTargets = phaseOrdinal === 3[\s\S]*?openPersonTargets/);
assert.match(operatorSource, /targetOrdinals: phaseOrdinals/);

assert.match(targetedSource, /const phasedExecution = options\.pocPhasePipeline === true \|\| Boolean\(options\.contactPhaseOrdinal\)/);
assert.match(targetedSource, /async function runPocPhasePipeline/);
assert.match(targetedSource, /ordinal: 1/);
assert.match(targetedSource, /ordinal: 2/);
assert.match(targetedSource, /ordinal: 3/);
assert.match(targetedSource, /\? await runPocPhasePipeline\(exact\.request, runOptions\)/);
assert.match(targetedSource, /: await base\.run\(exact\.request, runOptions\)/);
assert.match(targetedSource, /POC-phase pipeline:/);
assert.match(targetedSource, /poc-phase-deterministic-only/);
assert.match(targetedSource, /const phaseOrdinal = Number\(options\.contactPhaseOrdinal \|\| 0\) \|\| null/);
assert.match(targetedSource, /\(!phaseOrdinal \|\| phaseOrdinal === 1\)/);
assert.match(targetedSource, /\(!phaseOrdinal \|\| phaseOrdinal === 2\)/);
assert.doesNotMatch(targetedSource, /const boundedAiEnabled = aiBatchRescue\.enabled\(\) && options\.apolloApproved/);

console.log('Universal POC phase pipeline self-test passed: enrichment is sheet-wide POC-1 -> POC-2 -> POC-3, each phase is ordinal-scoped, POC-3 owns discovery when needed, and aggregate reporting preserves POC-2 residue.');
