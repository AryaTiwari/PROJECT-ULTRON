'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'core');
const controllerSource = fs.readFileSync(path.join(root, 'universal-spreadsheet-domain-controller.js'), 'utf8');
const handlerSource = fs.readFileSync(path.join(root, 'universal-paid-approval-handler.js'), 'utf8');
const inspectorSource = fs.readFileSync(path.join(root, 'universal-sheet-inspector.js'), 'utf8');

// Universal Google-Sheet enrichment owns its own approval operation. It must not
// be tunneled through the historical 3-POC approval or monkey-patch its executor.
assert.match(controllerSource, /approvalHandler\.OPERATION/);
assert.doesNotMatch(controllerSource, /agentic-three-poc-enrichment/);
assert.doesNotMatch(controllerSource, /legacyThreePoc|REQUEST_FLAG|universalCompatibilityRun/);
assert.match(handlerSource, /const OPERATION = 'universal-spreadsheet-enrichment'/);
assert.match(handlerSource, /paidTools\.withPermit\(decision/);
assert.match(handlerSource, /universal\.run\(/);
assert.doesNotMatch(handlerSource, /three-poc-enrichment-operator|handleThreePocCommand/);

// Pre-approval inspection must remain values/schema only. Apollo, LinkedIn and
// model APIs are forbidden here; exact enrichment begins only after approval.
assert.match(inspectorSource, /sheets\.values\(/);
assert.match(inspectorSource, /engine\.analyzeSheet\(/);
assert.doesNotMatch(inspectorSource, /apollo-enrichment|linkedin-mcp|model-router|OmniRoute|chatOmniRouteOnly/);
assert.match(inspectorSource, /inspectionMode: 'values-only-preapproval'/);
assert.match(inspectorSource, /UNIVERSAL_SHEET_VALUES_READ_FAILED/);
assert.match(inspectorSource, /UNIVERSAL_SHEET_PLANNING_FAILED/);

// Inspection failures must expose a stable stage rather than collapsing into a
// single generic tombstone.
assert.match(controllerSource, /errorStage: stage/);
assert.match(controllerSource, /unknown-inspection-stage/);

const handler = require('../core/universal-paid-approval-handler');
assert.equal(handler.OPERATION, 'universal-spreadsheet-enrichment');
assert.match(handler.modePrefix(undefined), /FULL-SHEET MODE/);
assert.match(handler.modePrefix(8), /VALIDATION MODE/);

console.log('Universal approval routing self-test passed: universal Google-Sheet enrichment has a first-class Apollo operation, pre-approval inspection is values/schema-only, legacy 3-POC approval is isolated, and inspection errors are stage-specific.');
