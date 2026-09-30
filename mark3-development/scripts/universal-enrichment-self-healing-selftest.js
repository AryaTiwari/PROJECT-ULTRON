#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ultron-self-healing-'));
process.env.ULTRON_M3_DIAGNOSTIC_STATE_PATH = path.join(fixture, 'diagnostics.json');
process.env.ULTRON_M3_BENCHMARK_STATE_PATH = path.join(fixture, 'benchmark.json');

const healer = require('../core/universal-enrichment-self-healer');
const diagnostics = require('../core/adaptive-diagnostic-layer');

(async () => {
  const network = Object.assign(new Error('fetch failed while reading metadata'), {
    code: 'GOOGLE_SHEETS_NETWORK_ERROR', subsystem: 'GOOGLE_SHEETS', errorType: 'NETWORK', stage: 'sheet-metadata-read',
  });
  const networkPlan = healer.recoveryPlan(network, { route: 'spreadsheet-enrichment' });
  assert.equal(networkPlan.autoRetry, true);
  assert.equal(networkPlan.safeAction, 'retry_safe_read');
  assert.equal(networkPlan.maxAttempts, 3);

  let attempts = 0;
  const healed = await diagnostics.attemptSafeRetry(diagnostics.assess(network, { route: 'spreadsheet-enrichment' }), async () => {
    attempts++;
    if (attempts === 1) throw network;
    return { ok: true, value: 'recovered' };
  });
  assert.equal(attempts, 2);
  assert.equal(healed.value, 'recovered');
  assert.equal(diagnostics.recent(10).some((item) => item.healed), true, 'healing outcome must survive in the durable diagnostic journal');
  assert.equal(healer.STATE_FILE, process.env.ULTRON_M3_DIAGNOSTIC_STATE_PATH, 'the test must remain isolated from production diagnostic history');

  const tabError = Object.assign(new Error('tab not found'), {
    code: 'GOOGLE_SHEETS_TAB_NOT_FOUND', subsystem: 'TARGETING', errorType: 'NOT_FOUND',
    stage: 'sheet-values-read', requestedSheetName: 'Aryatry', availableTabs: ['Arya', 'Aryatry ', 'Raw Data'],
  });
  const tabPlan = healer.recoveryPlan(tabError, { sheetName: 'Aryatry', exactTargetSupplied: true, availableTabs: tabError.availableTabs });
  assert.equal(tabPlan.safeAction, 'refetch_metadata');
  assert.equal(tabPlan.maxAttempts, 2);
  assert.equal(tabPlan.worksheet.closeMatches[0].name, 'Aryatry ');

  const schema = {
    confidence: 0.43, headerRowNumber: 2,
    columns: [
      { index: 0, header: 'Company', role: 'company', confidence: 0.91 },
      { index: 1, header: 'Who?', role: 'unknown', confidence: 0.1 },
    ],
    personGroups: [], companyGroups: [{ ordinal: 1, fields: { company: {} } }],
    safety: { safe: false, questions: ['Which column contains POC-1 name?'] },
  };
  const schemaPlan = healer.recoveryPlan(Object.assign(new Error('low confidence'), {
    code: 'UNIVERSAL_SCHEMA_CONFIDENCE_TOO_LOW', subsystem: 'SCHEMA', errorType: 'SCHEMA', stage: 'schema-confidence-gate', schema,
  }), { schema });
  assert.equal(schemaPlan.autoRetry, false, 'schema ambiguity must never be guessed automatically');
  assert.equal(schemaPlan.schema.unknownColumns[0].header, 'Who?');
  assert.match(schemaPlan.schema.questions[0], /POC-1/);

  const authPlan = healer.recoveryPlan(Object.assign(new Error('invalid grant'), {
    code: 'GOOGLE_SHEETS_AUTH_REQUIRED', subsystem: 'GOOGLE_SHEETS', errorType: 'AUTH', stage: 'sheet-metadata-read',
  }));
  assert.equal(authPlan.safeAction, 'refresh_auth_token');
  assert.equal(authPlan.authRedirectRequired, true);
  assert.equal(authPlan.autoRetry, false, 'interactive auth must not replay a paid mission');

  const benchmark = {
    buildFingerprint: require('../core/runtime-build').fingerprint,
    improvement: { elapsedPercent: 79, googleCallReduction: 95, apolloCallReduction: 30 },
    safety: { boundedWorkers: 3, actualUnsafeWrites: 0 },
  };
  assert.equal(healer.benchmarkPass(benchmark), true);
  healer.retainHealthyBenchmark(benchmark);
  assert.equal(healer.benchmarkStatus().healthy, true);
  assert.equal(healer.benchmarkPass({ ...benchmark, safety: { boundedWorkers: 3, actualUnsafeWrites: 1 } }), false);
  assert.equal(healer.benchmarkStatus().lastKnownGood.report.safety.actualUnsafeWrites, 0, 'a failing result must never replace last-known-good status');

  const authSource = fs.readFileSync(path.join(__dirname, '..', 'core', 'google-sheets-auth.js'), 'utf8');
  const uiSource = fs.readFileSync(path.join(__dirname, '..', 'interface', 'app.js'), 'utf8');
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(authSource, /google_auth_action_required/);
  assert.match(authSource, /authUrl: authUrl\.toString\(\)/);
  assert.match(uiSource, /google_auth_action_required/);
  assert.match(serverSource, /\/api\/diagnostics\/enrichment/);
  assert.match(serverSource, /durableAuthorization: authStatus\.durableAuthorization/);

  console.log('Universal enrichment self-healing regression passed: transient safe reads retry with bounds, tab failures expose exact target evidence, schema uncertainty asks instead of guessing, Google auth exposes a secure reconnect action, durable diagnostics survive restart, and failing benchmarks cannot replace last-known-good status.');
})().finally(() => {
  fs.rmSync(fixture, { recursive: true, force: true });
}).catch((error) => { console.error(error); process.exitCode = 1; });
