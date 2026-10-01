#!/usr/bin/env node
'use strict';

// Startup is an application entry point, not a 40+-test CI pipeline.
// CI owns exhaustive regressions; retain non-negotiable production safety
// checks in npm start. No Apollo requests, Sheet writes or runtime launch here.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const start = String(pkg.scripts?.start || '');
const full = String(pkg.scripts?.['check:startup-suite'] || '');
const enrichment = String(pkg.scripts?.['check:enrichment-safety'] || '');
const mustRunInStart = [
  'scripts/google-auth-integrity-guard.js',
  'scripts/universal-enrichment-production-selftest.js',
  'scripts/universal-enrichment-integrity-guard.js',
  'scripts/preflight.js',
  'scripts/start-transport.mjs',
  'scripts/replace-stale-mark3.js',
  'server.js',
];
for (const name of mustRunInStart) {
  assert.ok(start.includes(name), 'production startup must retain ' + name);
}
assert.ok(start.indexOf('scripts/preflight.js') < start.indexOf('scripts/start-transport.mjs'));
assert.ok(start.indexOf('scripts/replace-stale-mark3.js') < start.lastIndexOf('server.js'));
assert.ok(!start.includes('scripts/three-poc-internal-inference-selftest.js'),
  'comprehensive nested regression cannot block server startup');
assert.ok(!start.includes('scripts/contact-architecture-contract-selftest.js'),
  'fragile textual contract assertions must run in CI, not before launch');
const testFiles = [...start.matchAll(/scripts\/([A-Za-z0-9-]+-selftest\.js)/g)]
  .map((match) => match[1])
  .filter((name) => name !== 'universal-enrichment-production-selftest.js');
assert.deepEqual(testFiles, [], 'no unrelated feature regression should gate app startup');
for (const name of [
  'scripts/contact-architecture-contract-selftest.js',
  'scripts/three-poc-internal-inference-selftest.js',
  'scripts/flow-selftest.js',
  'scripts/forge-selftest.js',
  'scripts/reel-finisher-selftest.js',
  'scripts/apollo-lead-benchmark.js',
]) {
  assert.ok(full.includes(name), 'full CI startup suite must retain ' + name);
}
assert.ok(enrichment.includes('scripts/startup-boundary-selftest.js'),
  'CI safety stage must lock the production startup boundary');
console.log('Mark 3 startup boundary passed: mandatory live guards retained, server launch ordered, and exhaustive regressions moved to CI without removing them.');
