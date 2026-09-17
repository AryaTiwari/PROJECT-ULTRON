'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'core');
const pickleSource = fs.readFileSync(path.join(root, 'three-poc-big-pickle-override.js'), 'utf8');
const tabSource = fs.readFileSync(path.join(root, 'three-poc-direct-tab-fallback.js'), 'utf8');
const controllerSource = fs.readFileSync(path.join(root, 'three-poc-domain-controller.js'), 'utf8');
const providerSource = fs.readFileSync(path.join(root, 'provider-registry.js'), 'utf8');

// Big Pickle remains globally blocked from ordinary auto-routing. This temporary
// path must be an explicit scoped exception, not a new global default.
assert.ok(providerSource.includes('/big[-_ ]?pickle/i'), 'Big Pickle must remain blocked from ordinary auto-routing');
assert.match(pickleSource, /ULTRON_M3_THREE_POC_BIG_PICKLE/);
assert.match(pickleSource, /oc\/big-pickle/);
assert.match(pickleSource, /skipModelValidation: true/);
assert.match(pickleSource, /routingMode: 'big-pickle-only'/);
assert.match(pickleSource, /personalApiFallbackAllowed: false/);
assert.doesNotMatch(pickleSource, /modelRouter\.chat\(/);

// OpenCode disable policy is authoritative even in temporary mode.
assert.match(pickleSource, /ULTRON_M3_DISABLE_OPENCODE/);
assert.match(pickleSource, /BIG_PICKLE_OPENCODE_DISABLED/);

// Exact source + exact tab scope are both mandatory. This prevents @mentions
// from being interpreted as local XLSX by the old source compiler.
assert.match(controllerSource, /ULTRON_M3_THREE_POC_SOURCE_URL/);
assert.match(controllerSource, /BIG_PICKLE_SOURCE_URL_REQUIRED/);
assert.match(controllerSource, /sourcePinnedMessage/);
assert.match(controllerSource, /if \(bigPickleMode\(\)\)/);
assert.match(controllerSource, /defaultUniversalGoogleDispatch/);
assert.match(tabSource, /ULTRON_M3_THREE_POC_TARGET_SHEET/);
assert.match(tabSource, /ULTRON_M3_THREE_POC_TARGET_GID/);
assert.match(tabSource, /restrictMetadata/);
assert.match(tabSource, /metadataScoped/);
assert.match(tabSource, /metadataFallbacks/);
assert.match(tabSource, /googleSheets\.sheetGid = function forcedConfiguredGid/);
assert.match(controllerSource, /BIG_PICKLE_TARGET_SHEET_REQUIRED/);

const directTab = require('../core/three-poc-direct-tab-fallback');
const meta = {
  properties: { title: 'Test' },
  sheets: [
    { properties: { title: 'Gaurav 2', sheetId: 1317116143, index: 0 } },
    { properties: { title: 'Arya 2', sheetId: 1791507355, index: 1 } },
  ],
};
const scoped = directTab.restrictMetadata(meta, 'Arya 2', 1791507355);
assert.ok(scoped);
assert.equal(scoped.sheets.length, 1);
assert.equal(scoped.sheets[0].properties.title, 'Arya 2');
assert.equal(scoped.sheets[0].properties.sheetId, 1791507355);
assert.equal(directTab.restrictMetadata(meta, 'Missing', 999), null);

// Source pinning behavior is tested with a temporary environment override.
const oldSource = process.env.ULTRON_M3_THREE_POC_SOURCE_URL;
try {
  process.env.ULTRON_M3_THREE_POC_SOURCE_URL = 'https://docs.google.com/spreadsheets/d/testSpreadsheet123/edit#gid=1791507355';
  const controller = require('../core/three-poc-domain-controller');
  assert.equal(controller.bigPickleSourceUrl(), 'https://docs.google.com/spreadsheets/d/testSpreadsheet123/edit#gid=1791507355');
  const pinned = controller.sourcePinnedMessage('Use @New_Sheet_14-09-25 and run anchored 3-POC on Arya 2.');
  assert.match(pinned, /^https:\/\/docs\.google\.com\/spreadsheets\/d\/testSpreadsheet123\/edit#gid=1791507355/);
  assert.match(pinned, /@New_Sheet_14-09-25/);
} finally {
  if (oldSource == null) delete process.env.ULTRON_M3_THREE_POC_SOURCE_URL;
  else process.env.ULTRON_M3_THREE_POC_SOURCE_URL = oldSource;
}

console.log('Big Pickle 3-POC fallback self-test passed: the workaround is opt-in, Big Pickle-only, personal-key-free, OpenCode-policy-aware, pinned to one canonical Google source and one exact worksheet, and @mentions cannot fall back to local XLSX.');
