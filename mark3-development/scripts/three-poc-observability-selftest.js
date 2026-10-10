'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const operator = require('../core/three-poc-enrichment-operator');

const defaultPolicy = operator.currentPhonePolicy({});
assert.deepEqual(defaultPolicy, {
  version: 'india-phone-first-5-attempts-v1',
  mode: 'india-first-5-attempts',
});
assert.equal(operator.currentPhonePolicy({ phonePolicyMode: 'general' }).mode, 'general');

const stats = {};
const originalNow = Date.now;
try {
  let clock = 1000;
  Date.now = () => clock;
  operator.recordStageLatency(stats, 'candidateSearch', 995); // 5ms
  clock = 1010;
  operator.recordStageLatency(stats, 'candidateSearch', 1000); // 10ms
  clock = 1040;
  operator.recordStageLatency(stats, 'candidateSearch', 1020); // 20ms
} finally {
  Date.now = originalNow;
}
operator.summarizeStageLatency(stats);
assert.deepEqual(stats.stageLatencyMs.candidateSearch, {
  count: 3,
  total: 35,
  max: 20,
  p50: 10,
  p95: 20,
  average: 12,
});

const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'three-poc-enrichment-operator.js'), 'utf8');
assert.match(source, /phonePolicyVersion: phonePolicy\.version/);
assert.match(source, /phonePolicyMode: phonePolicy\.mode/);
assert.match(source, /THREE_POC_RESUME_POLICY_MISMATCH/);
assert.match(source, /recordStageLatency\(stats, 'candidateSearch'/);
assert.match(source, /recordStageLatency\(stats, 'selector'/);
assert.match(source, /recordStageLatency\(stats, 'reviewer'/);
assert.match(source, /recordStageLatency\(stats, 'candidateHydration'/);
assert.match(source, /recordStageLatency\(stats, 'sheetWrite'/);
assert.match(source, /Stage latency:/);

console.log('Three-POC observability selftest: PASS');
