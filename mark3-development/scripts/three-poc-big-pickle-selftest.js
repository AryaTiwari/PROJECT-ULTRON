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

// Exact-tab scope is mandatory and applies even when normal metadata succeeds.
assert.match(tabSource, /ULTRON_M3_THREE_POC_TARGET_SHEET/);
assert.match(tabSource, /ULTRON_M3_THREE_POC_TARGET_GID/);
assert.match(tabSource, /restrictMetadata/);
assert.match(tabSource, /metadataScoped/);
assert.match(tabSource, /metadataFallbacks/);
assert.match(controllerSource, /BIG_PICKLE_TARGET_SHEET_REQUIRED/);
assert.match(controllerSource, /if \(googleUrl && !bigPickleMode\(\)\)/);
assert.match(controllerSource, /if \(googleUrl && bigPickleMode\(\)\)/);
assert.match(controllerSource, /defaultUniversalGoogleDispatch/);

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

console.log('Big Pickle 3-POC fallback self-test passed: the workaround is opt-in, Big Pickle-only, personal-key-free, OpenCode-policy-aware, and pinned to one exact configured worksheet even when normal metadata succeeds.');
