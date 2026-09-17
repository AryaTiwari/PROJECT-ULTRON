'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'core');
const controllerSource = fs.readFileSync(path.join(root, 'universal-spreadsheet-domain-controller.js'), 'utf8');
const handlerSource = fs.readFileSync(path.join(root, 'universal-paid-approval-handler.js'), 'utf8');
const inspectorSource = fs.readFileSync(path.join(root, 'universal-sheet-inspector.js'), 'utf8');
const controlSource = fs.readFileSync(path.join(root, 'command-control-plane.js'), 'utf8');

assert.match(controllerSource, /approvalHandler\.OPERATION/);
assert.doesNotMatch(controllerSource, /agentic-three-poc-enrichment/);
assert.doesNotMatch(controllerSource, /legacyThreePoc|REQUEST_FLAG|universalCompatibilityRun/);
assert.match(handlerSource, /const OPERATION = 'universal-spreadsheet-enrichment'/);
assert.match(handlerSource, /paidTools\.withPermit\(decision/);
assert.match(handlerSource, /universal\.run\(/);
assert.doesNotMatch(handlerSource, /three-poc-enrichment-operator|handleThreePocCommand/);
assert.doesNotMatch(handlerSource, /assistant\.handle\s*=/);
assert.match(handlerSource, /owner: 'command-control-plane'/);

assert.match(controlSource, /async function resolveUniversalPaidApproval/);
assert.match(controlSource, /paidTools\.resolveMessage/);
assert.match(controlSource, /handler\.execute\(decision\)/);
assert.match(controlSource, /const paidApprovalResult = await resolveUniversalPaidApproval\(originalMessage\)/);
assert.match(controlSource, /if \(paidApprovalResult\) return paidApprovalResult/);
assert.match(controlSource, /controller: 'universal-spreadsheet-domain-controller'/);

assert.match(inspectorSource, /sheets\.values\(/);
assert.match(inspectorSource, /engine\.analyzeSheet\(/);
assert.doesNotMatch(inspectorSource, /apollo-enrichment|linkedin-mcp|model-router|OmniRoute|chatOmniRouteOnly/);
assert.match(inspectorSource, /inspectionMode: 'values-only-preapproval'/);
assert.match(inspectorSource, /UNIVERSAL_SHEET_VALUES_READ_FAILED/);
assert.match(inspectorSource, /UNIVERSAL_SHEET_PLANNING_FAILED/);

assert.match(controllerSource, /errorStage: stage/);
assert.match(controllerSource, /unknown-inspection-stage/);

const control = require('../core/command-control-plane');
const handler = require('../core/universal-paid-approval-handler');
const controller = require('../core/universal-spreadsheet-domain-controller');

assert.equal(handler.OPERATION, 'universal-spreadsheet-enrichment');
assert.match(handler.modePrefix(undefined), /FULL-SHEET MODE/);
assert.match(handler.modePrefix(8), /VALIDATION MODE/);
assert.equal(handler.install().owner, 'command-control-plane');

const universalRoute = control.claim(
  'Use https://docs.google.com/spreadsheets/d/example123/edit and enrich all contact groups with Apollo.',
  {}
);
assert.equal(universalRoute.domain, 'spreadsheet-enrichment');
assert.equal(universalRoute.controller, 'universal-spreadsheet-domain-controller');
assert.equal(universalRoute.exclusive, true);
assert.equal(universalRoute.generalModelAllowed, false);

// Regression for the real full-sheet command shape used by the chat UI. An @file
// mention plus explicit Gaurav 2 targeting and universal contact-group language
// must never be mistaken for the legacy fixed 3-POC workflow.
const gauravCommand = [
  'Use the Google Sheet @New_Sheet_14-09-25',
  'Target only the `Gaurav 2` tab.',
  'Run a FULL-SHEET universal deterministic contact-enrichment pass.',
  'Analyze the worksheet schema deterministically.',
  'Preserve existing valid values.',
  'For empty contact groups resolve the exact anchor employer and discover employees broadly using Apollo.',
  'For partial groups with phone/email but no identity verify the exact same person before assignment.',
  'AI/model calls = 0.',
].join('\n');
const gauravRoute = control.claim(gauravCommand, {});
assert.equal(gauravRoute.domain, 'spreadsheet-enrichment');
assert.equal(gauravRoute.controller, 'universal-spreadsheet-domain-controller');
assert.equal(gauravRoute.exclusive, true);
assert.equal(gauravRoute.generalModelAllowed, false);
assert.equal(controller.parseSheetName(gauravCommand), 'Gaurav 2');

const googleThreePocRoute = control.claim(
  'Use https://docs.google.com/spreadsheets/d/example123/edit and run 3 POCs: first POC, second POC, third POC enrichment.',
  {}
);
assert.equal(googleThreePocRoute.domain, 'three-poc-spreadsheet');
assert.equal(googleThreePocRoute.controller, 'three-poc-domain-controller');

console.log('Universal approval routing self-test passed: the Gaurav 2 full-sheet command is first-class, approval re-entry is command-control owned, pre-approval inspection is values/schema-only, explicit legacy 3-POC compatibility stays isolated, and inspection errors are stage-specific.');
