'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('./config');
const typedErrors = require('./spreadsheet-enrichment-errors');
const recovery = require('./universal-enrichment-recovery');

const TEST_PROCESS = /(?:selftest|benchmark|integrity-guard)\.(?:js|mjs|cjs)$/i.test(path.basename(process.argv[1] || ''));
const STATE_FILE = process.env.ULTRON_M3_DIAGNOSTIC_STATE_PATH
  ? path.resolve(process.env.ULTRON_M3_DIAGNOSTIC_STATE_PATH)
  : TEST_PROCESS
    ? path.join(os.tmpdir(), 'ultron-mark3-diagnostic-tests', `${process.pid}.json`)
    : path.join(config.projectRoot, '.ultron', 'universal-enrichment', 'diagnostics.json');
const BENCHMARK_FILE = process.env.ULTRON_M3_BENCHMARK_STATE_PATH
  ? path.resolve(process.env.ULTRON_M3_BENCHMARK_STATE_PATH)
  : path.join(config.projectRoot, '.ultron', 'universal-enrichment', 'benchmark-status.json');
const CONTRACT_FILE = path.join(config.mark3Root, 'universal-enrichment-benchmark-contract.json');
const MAX_EVENTS = 100;

function text(value) { return String(value == null ? '' : value).trim(); }
function cleanList(values, limit = 20) {
  return [...new Set((Array.isArray(values) ? values : []).map(text).filter(Boolean))].slice(0, limit);
}
function cleanTabs(values, limit = 50) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const exact = String(value == null ? '' : value);
    if (!exact.trim() || seen.has(exact)) continue;
    seen.add(exact);
    out.push(exact);
    if (out.length >= limit) break;
  }
  return out;
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}
function sanitizedContext(context = {}) {
  return {
    route: text(context.route) || null,
    sheetName: text(context.sheetName) || null,
    spreadsheetId: text(context.spreadsheetId) || null,
    availableTabs: cleanTabs(context.availableTabs),
    attemptedRange: text(context.attemptedRange) || null,
    exactTargetSupplied: Boolean(context.exactTargetSupplied || context.sheetName),
    approvalReentry: Boolean(context.approvalReentry),
    paidExecution: Boolean(context.paidExecution),
  };
}

function recordDiagnosis(entry = {}) {
  const state = readJson(STATE_FILE, { version: 1, events: [] });
  const safe = {
    at: new Date().toISOString(),
    code: text(entry.code) || 'UNIVERSAL_INTERNAL_UNCLASSIFIED',
    subsystem: text(entry.subsystem) || 'UNIVERSAL',
    type: text(entry.type) || 'INTERNAL',
    stage: text(entry.stage) || 'diagnostic',
    safeAction: text(entry.safeAction) || null,
    healed: Boolean(entry.healed),
    userActionRequired: Boolean(entry.userActionRequired),
    ...sanitizedContext(entry),
  };
  state.version = 1;
  state.updatedAt = safe.at;
  state.events = [...(Array.isArray(state.events) ? state.events : []), safe].slice(-MAX_EVENTS);
  try { atomicWrite(STATE_FILE, state); } catch {}
  return safe;
}

function recent(limit = 10) {
  const state = readJson(STATE_FILE, { events: [] });
  return (Array.isArray(state.events) ? state.events : []).slice(-Math.max(1, Math.min(50, Number(limit) || 10)));
}

function normalizedName(value) {
  return text(value).toLocaleLowerCase().replace(/[_\-.]+/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function tabScore(requested, candidate) {
  const wanted = normalizedName(requested);
  const actual = normalizedName(candidate);
  if (!wanted || !actual) return 0;
  if (wanted === actual) return 1;
  if (wanted.includes(actual) || actual.includes(wanted)) return 0.85;
  const a = new Set(wanted.split(' '));
  const b = new Set(actual.split(' '));
  const overlap = [...a].filter((item) => b.has(item)).length;
  return overlap / Math.max(a.size, b.size, 1);
}
function worksheetDiagnostic(error = {}, context = {}) {
  const requested = text(context.sheetName || error.requestedSheetName);
  const availableTabs = cleanTabs(context.availableTabs || error.availableTabs);
  const closeMatches = availableTabs
    .map((name) => ({ name, score: tabScore(requested, name) }))
    .filter((item) => item.score >= 0.45)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  return {
    requestedSheetName: requested || null,
    requestedGid: context.requestedGid ?? error.requestedGid ?? null,
    availableTabs,
    closeMatches,
    exactAutoMatch: closeMatches.length === 1 && closeMatches[0].score === 1 ? closeMatches[0].name : null,
  };
}

function schemaDiagnostic(schema = {}) {
  const columns = Array.isArray(schema.columns) ? schema.columns : [];
  const mappedColumns = columns
    .filter((column) => column?.role && column.role !== 'unknown')
    .map((column) => ({ column: Number(column.index) + 1, header: text(column.header), role: column.role, confidence: Number(column.confidence || 0) }));
  const unknownColumns = columns
    .filter((column) => text(column?.header) && (!column.role || column.role === 'unknown'))
    .map((column) => ({ column: Number(column.index) + 1, header: text(column.header) }));
  return {
    confidence: Number(schema.confidence || 0),
    headerRowNumber: Number(schema.headerRowNumber || 0) || null,
    mappedColumns,
    unknownColumns,
    questions: cleanList(schema.safety?.questions || schema.questions),
    personGroups: (schema.personGroups || []).map((group) => ({ ordinal: group.ordinal, fields: Object.keys(group.fields || {}) })),
    companyGroups: (schema.companyGroups || []).map((group) => ({ ordinal: group.ordinal, fields: Object.keys(group.fields || {}) })),
    safeToWrite: schema.safety?.safe !== false && Number(schema.confidence || 0) >= 0.55,
  };
}

function recoveryPlan(error = {}, context = {}) {
  const typed = typedErrors.normalize(error, { stage: error?.stage || context.stage || 'diagnostic' });
  const code = text(typed.code).toUpperCase();
  const preApproval = !context.approvalReentry && !context.paidExecution;
  const safeReadStage = /metadata|inspection|preapproval|target|schema|read/i.test(text(typed.stage));
  const googleAuth = typed.subsystem === 'GOOGLE_SHEETS' && ['AUTH', 'PERMISSION'].includes(typed.type);
  const tabFailure = /TAB_NOT_FOUND|GID_NOT_FOUND|TARGET_REQUIRED|TARGETING_FAILED/.test(code) || typed.subsystem === 'TARGETING';
  const schemaFailure = /SCHEMA|CONFIDENCE|AMBIGUOUS|COLUMN/.test(code) || typed.subsystem === 'SCHEMA';
  const transientRead = preApproval && safeReadStage && ['NETWORK', 'TIMEOUT'].includes(typed.type);
  const refetchTarget = preApproval && tabFailure && Boolean(context.exactTargetSupplied || context.sheetName);
  const safeAction = googleAuth
    ? 'refresh_auth_token'
    : transientRead
      ? 'retry_safe_read'
      : refetchTarget
        ? 'refetch_metadata'
        : typed.type === 'RATE_LIMIT' || typed.type === 'COOLDOWN'
          ? 'wait_cooldown'
          : null;
  if (safeAction) recovery.assert(safeAction);
  return {
    typed,
    code,
    safeAction,
    autoRetry: Boolean(transientRead || refetchTarget),
    maxAttempts: transientRead ? 3 : refetchTarget ? 2 : 1,
    backoffMs: transientRead ? [250, 750] : refetchTarget ? [300] : [],
    authRedirectRequired: googleAuth,
    userActionRequired: Boolean(schemaFailure || (tabFailure && !refetchTarget) || googleAuth),
    worksheet: tabFailure ? worksheetDiagnostic(error, context) : null,
    schema: schemaFailure ? schemaDiagnostic(context.schema || error.schema || {}) : null,
  };
}

function benchmarkContract() {
  return readJson(CONTRACT_FILE, {
    contractVersion: 'universal-enrichment-benchmark-v1',
    minimumElapsedImprovementPercent: 60,
    minimumGoogleCallReductionPercent: 80,
    minimumApolloCallReductionPercent: 15,
    maximumUnsafeWrites: 0,
    maximumWorkers: 3,
  });
}
function benchmarkPass(report = {}, contract = benchmarkContract()) {
  return Number(report?.improvement?.elapsedPercent || 0) >= Number(contract.minimumElapsedImprovementPercent || 0)
    && Number(report?.improvement?.googleCallReduction || 0) >= Number(contract.minimumGoogleCallReductionPercent || 0)
    && Number(report?.improvement?.apolloCallReduction || 0) >= Number(contract.minimumApolloCallReductionPercent || 0)
    && Number(report?.safety?.actualUnsafeWrites ?? report?.safety?.unsafeWrites ?? Infinity) <= Number(contract.maximumUnsafeWrites ?? 0)
    && Number(report?.safety?.boundedWorkers || Infinity) <= Number(contract.maximumWorkers || 3);
}
function retainHealthyBenchmark(report = {}) {
  const contract = benchmarkContract();
  if (!benchmarkPass(report, contract)) return { retained: false, healthy: false, contract };
  const state = { version: 1, healthy: true, verifiedAt: new Date().toISOString(), contractVersion: contract.contractVersion, report };
  try {
    atomicWrite(BENCHMARK_FILE, state);
    const retained = readJson(BENCHMARK_FILE, null);
    if (retained?.report?.buildFingerprint !== report.buildFingerprint) throw new Error('benchmark retention verification failed');
  } catch (error) {
    return { retained: false, healthy: false, contract, error: text(error?.message) || 'benchmark retention failed' };
  }
  return { retained: true, ...state, contract };
}
function benchmarkStatus() {
  const contract = benchmarkContract();
  const lastKnownGood = readJson(BENCHMARK_FILE, null);
  let currentFingerprint = null;
  try { currentFingerprint = require('./runtime-build').fingerprint; } catch {}
  return {
    healthy: Boolean(lastKnownGood?.healthy
      && benchmarkPass(lastKnownGood.report, contract)
      && (!currentFingerprint || lastKnownGood?.report?.buildFingerprint === currentFingerprint)),
    contract,
    lastKnownGood,
    currentFingerprint,
    stateFile: BENCHMARK_FILE,
  };
}

module.exports = {
  STATE_FILE,
  BENCHMARK_FILE,
  cleanList,
  cleanTabs,
  recordDiagnosis,
  recent,
  worksheetDiagnostic,
  schemaDiagnostic,
  recoveryPlan,
  benchmarkContract,
  benchmarkPass,
  retainHealthyBenchmark,
  benchmarkStatus,
};
