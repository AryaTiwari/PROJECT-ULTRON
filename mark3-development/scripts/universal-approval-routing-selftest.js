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
assert.match(handlerSource, /const deterministicBootstrap = require\('\.\/universal-deterministic-bootstrap'\)/);
assert.match(handlerSource, /deterministicBootstrap\.install\(\)/);
assert.match(handlerSource, /paidTools\.withPermit\(decision/);
assert.match(handlerSource, /universal\.run\(/);
assert.match(handlerSource, /canonicalApprovedTarget/);
assert.match(handlerSource, /matchedBy: 'sheetId'/);
assert.match(handlerSource, /approved-target-canonicalization/);
assert.match(handlerSource, /\[universal-sheet · build/);
assert.doesNotMatch(handlerSource, /three-poc-enrichment-operator|handleThreePocCommand/);
assert.doesNotMatch(handlerSource, /assistant\.handle\s*=/);
assert.match(handlerSource, /owner: 'command-control-plane'/);

assert.match(controlSource, /async function resolveUniversalPaidApproval/);
assert.match(controlSource, /paidTools\.resolveMessage/);
assert.match(controlSource, /handler\.execute\(decision\)/);
assert.match(controlSource, /try \{[\s\S]*?result = await handler\.execute\(decision\)/);
assert.match(controlSource, /typedErrors\.normalize\(error,[\s\S]*?approval-reentry-dispatch/);
assert.match(controlSource, /Universal spreadsheet approval re-entry stopped safely/);
assert.match(controlSource, /const paidApprovalResult = await resolveUniversalPaidApproval\(originalMessage\)/);
assert.match(controlSource, /if \(paidApprovalResult\) return paidApprovalResult/);
assert.match(controlSource, /controller: 'universal-spreadsheet-domain-controller'/);

assert.match(inspectorSource, /sheets\.values\(/);
assert.match(inspectorSource, /engine\.analyzeSheet\(/);
assert.doesNotMatch(inspectorSource, /apollo-enrichment|linkedin-mcp|model-router|OmniRoute|chatOmniRouteOnly/);
assert.match(inspectorSource, /inspectionMode: 'values-only-preapproval'/);
assert.match(inspectorSource, /UNIVERSAL_SHEET_VALUES_READ_FAILED/);
assert.match(inspectorSource, /UNIVERSAL_SHEET_PLANNING_FAILED/);

// Typed-error regression: verify the contract, not a historical local-variable spelling.
// The controller now normalizes failures once, exposes the canonical fields from
// typedFailure(), and spreads those fields into both source-resolution and
// pre-approval inspection responses.
assert.match(controllerSource, /const typedErrors = require\('\.\/spreadsheet-enrichment-errors'\)/);
assert.match(controllerSource, /function typedFailure\(error, context = \{\}\)/);
assert.match(controllerSource, /errorSubsystem: typed\.subsystem/);
assert.match(controllerSource, /errorType: typed\.type/);
assert.match(controllerSource, /errorCode: typed\.code/);
assert.match(controllerSource, /errorStage: typed\.stage/);
assert.match(controllerSource, /errorHint: typed\.hint/);
assert.match(controllerSource, /\.\.\.failure\.fields/);
assert.match(controllerSource, /typedFailure\(error, \{ stage: error\?\.stage \|\| 'preapproval-inspection' \}\)/);
assert.doesNotMatch(controllerSource, /unknown-inspection-stage/);

const control = require('../core/command-control-plane');
const handler = require('../core/universal-paid-approval-handler');
const controller = require('../core/universal-spreadsheet-domain-controller');
const sheets = require('../core/google-sheets-operator');

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
assert.equal(controller.parseSheetName('Worksheet Arya'), 'Arya');
assert.equal(controller.parseSheetName('Worksheet "Arya".'), 'Arya');

const googleThreePocRoute = control.claim(
  'Use https://docs.google.com/spreadsheets/d/example123/edit and run 3 POCs: first POC, second POC, third POC enrichment.',
  {}
);
assert.equal(googleThreePocRoute.domain, 'three-poc-spreadsheet');
assert.equal(googleThreePocRoute.controller, 'three-poc-domain-controller');


(async () => {
  const originalMetadata = sheets.metadata;
  const originalSpreadsheetId = sheets.spreadsheetId;
  try {
    sheets.spreadsheetId = () => 'sheet-123';
    sheets.metadata = async () => ({
      sheets: [
        { properties: { title: 'Divya', sheetId: 0 } },
        { properties: { title: 'Arya ', sheetId: 1566066221 } },
      ],
    });

    const exact = await handler.canonicalApprovedTarget({
      url: 'https://docs.google.com/spreadsheets/d/sheet-123/edit',
      sheetName: 'Arya',
      sheetId: 1566066221,
    });
    assert.equal(exact.sheetName, 'Arya ');
    assert.equal(exact.sheetId, 1566066221);
    assert.equal(exact.matchedBy, 'sheetId');

    const folded = await handler.canonicalApprovedTarget({
      url: 'https://docs.google.com/spreadsheets/d/sheet-123/edit',
      sheetName: 'Arya',
      sheetId: null,
    });
    assert.equal(folded.sheetName, 'Arya ');
    assert.equal(folded.matchedBy, 'folded-name');
  } finally {
    sheets.metadata = originalMetadata;
    sheets.spreadsheetId = originalSpreadsheetId;
  }

  console.log('Universal approval routing self-test passed: approval re-entry installs deterministic hardening, canonicalizes the live worksheet by sheetId before Apollo execution, preserves trailing-space Google titles, accepts plain Worksheet Arya targeting, handler failures are typed before the HTTP boundary, the Gaurav 2 full-sheet command remains first-class, and typed inspection errors expose the canonical subsystem/type/code/stage contract.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
