'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const DEFAULT_DIR = path.join(config.projectRoot, '.ultron', 'universal-enrichment');
const FILE = process.env.ULTRON_M3_ENRICHMENT_MISSION_STORE
  ? path.resolve(process.env.ULTRON_M3_ENRICHMENT_MISSION_STORE)
  : path.join(DEFAULT_DIR, 'missions.json');
const DIR = path.dirname(FILE);
const BACKUP = FILE + '.bak';

const RESUMABLE = new Set([
  'INSPECTING',
  'AWAITING_APOLLO_APPROVAL',
  'READY',
  'RUNNING',
  'WAITING_PROVIDER',
  'WAITING_PHONE_CALLBACKS',
  'WAITING_BUDGET',
  'PAUSED',
  'INTERRUPTED',
  'PARTIAL',
  'PARTIAL_BUDGET_EXHAUSTED',
  'FAILED_SAFE',
]);

const TERMINAL_ROW_STATES = new Set([
  'COMPLETE',
  'NO_DATA',
  'NO_VERIFIED_PERSON',
  'NO_CONTACT',
  'NO_EMAIL_AVAILABLE',
  'NO_PHONE_AVAILABLE',
  'EMAIL_NOT_AVAILABLE',
  'PHONE_NOT_AVAILABLE',
  'EMPLOYER_MISMATCH',
  'APOLLO_EXHAUSTED',
  'LINKEDIN_EXHAUSTED',
]);

const now = () => new Date().toISOString();

function empty() {
  return { version: 1, missions: [] };
}

function read(file = FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { version: 1, missions: Array.isArray(parsed.missions) ? parsed.missions : [] };
  } catch {
    return null;
  }
}

function load() {
  return read(FILE) || read(BACKUP) || empty();
}

function save(state) {
  fs.mkdirSync(DIR, { recursive: true });
  const temp = `${FILE}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify({ version: 1, missions: (state.missions || []).slice(-60) }, null, 2);
  fs.writeFileSync(temp, payload, { mode: 0o600 });
  JSON.parse(fs.readFileSync(temp, 'utf8'));
  if (fs.existsSync(FILE)) fs.copyFileSync(FILE, BACKUP);
  if (fs.existsSync(FILE)) fs.rmSync(FILE, { force: true });
  fs.renameSync(temp,FILE);
  try { fs.chmodSync(FILE, 0o600); } catch {}
  return state;
}

function create(input = {}) {
  const state = load();
  if (input.requestKey) {
    const existing = [...state.missions].reverse()
      .find((m) => m.requestKey === input.requestKey && m.completionState !== 'COMPLETE');
    if (existing) return existing;
  }

  const at = now();
  const explicitStart = Number(input.startRow);
  const explicitEnd = Number(input.endRow);
  const mission = {
    requestKey: input.requestKey || null,
    missionId: `enrich-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    provider: input.provider || 'apollo',
    spreadsheetId: input.spreadsheetId || null,
    spreadsheetUrl: input.spreadsheetUrl || null,
    spreadsheetTitle: input.spreadsheetTitle || null,
    sheetName: input.sheetName || null,
    sheetId: input.sheetId ?? null,
    schemaFingerprint: input.schemaFingerprint || null,
    requestedPOCs: input.requestedPOCs || [],
    requestedFields: input.requestedFields || [],
    ignoredFields: input.ignoredFields || [],
    readScope: input.readScope || [],
    writeScope: input.writeScope || null,
    protectedColumns: input.protectedColumns || [],
    status: input.status || 'INSPECTING',
    createdAt: at,
    updatedAt: at,
    startedAt: null,
    completedAt: null,
    totalEligibleRows: Number(input.totalEligibleRows || 0),
    rowsProcessed: 0,
    rowsRemaining: Number(input.totalEligibleRows || 0),
    rowCheckpoints: {},
    startRow: Number.isInteger(explicitStart) ? explicitStart : null,
    endRow: Number.isInteger(explicitEnd) ? explicitEnd : null,
    lastProcessedRow: null,
    lastVerifiedWriteRow: null,
    nextRow: Number.isInteger(explicitStart) ? explicitStart : null,
    frontierSource: Number.isInteger(explicitStart) ? 'mission-created' : null,
    apolloCalls: 0,
    apolloCacheHits: 0,
    apolloDiscoveryCalls: 0,
    apolloHydrations: 0,
    apolloPhoneReveals: 0,
    aiAttempts: 0,
    providerState: {},
    lastSafeCheckpoint: null,
    completionState: 'INSPECTING',
    approvalId: null,
    approvalValid: false,
    nextEligibleAt: null,
    nextEligibleAtSource: null,
    apolloUsageLedger: {
      discoveryCalls: 0,
      discoveryCacheHits: 0,
      personHydrations: 0,
      hydrationCacheHits: 0,
      emailRequests: 0,
      phoneReveals: 0,
      phoneRevealFallbacks: 0,
      failedCalls: 0,
      rateLimits: 0,
      estimatedCreditsConsumed: null,
    },
    budget: input.budget || {},
    provenance: [],
    request: input.request || null,
    lastError: null,
  };

  state.missions.push(mission);
  save(state);
  return mission;
}

function update(id, patch = {}) {
  const state = load();
  const index = state.missions.findIndex((m) => m.missionId === id);
  if (index < 0) return null;
  const current = state.missions[index];
  const next = {
    ...current,
    ...patch,
    providerState: { ...(current.providerState || {}), ...(patch.providerState || {}) },
    apolloUsageLedger: { ...(current.apolloUsageLedger || {}), ...(patch.apolloUsageLedger || {}) },
    updatedAt: now(),
  };
  state.missions[index] = next;
  save(state);
  return next;
}

function get(id) {
  return load().missions.find((m) => m.missionId === id) || null;
}

function list(limit = 20) {
  return load().missions.slice(-Math.max(1, limit)).reverse();
}

function latest() {
  return list(1)[0] || null;
}

function byRequestKey(key) {
  return list(60).find((m) => m.requestKey === key) || null;
}

function latestResumable() {
  return list(60).find((m) => RESUMABLE.has(m.status) && m.completionState !== 'COMPLETE') || null;
}

function rowIsProcessed(row = {}) {
  return Boolean(row.processed || TERMINAL_ROW_STATES.has(row.state));
}

function processedRows(rows = {}) {
  return Object.values(rows).filter(rowIsProcessed);
}

function frontierFromRows(rows = {}) {
  const numbers = processedRows(rows)
    .map((row) => Number(row.rowNumber))
    .filter(Number.isInteger);
  return numbers.length ? Math.max(...numbers) : null;
}

function checkpointRow(id, rowNumber, data = {}) {
  const mission = get(id);
  if (!mission) return null;

  const numericRow = Number(rowNumber);
  if (!Number.isInteger(numericRow)) return mission;

  const rows = { ...(mission.rowCheckpoints || {}) };
  const key = String(numericRow);
  rows[key] = {
    ...(rows[key] || {}),
    ...data,
    rowNumber: numericRow,
    updatedAt: now(),
  };

  const processed = processedRows(rows).length;
  const isProcessed = rowIsProcessed(rows[key]);
  const priorFrontier = Number.isInteger(Number(mission.lastProcessedRow))
    ? Number(mission.lastProcessedRow)
    : null;
  const nextFrontier = isProcessed
    ? Math.max(priorFrontier || 0, numericRow)
    : priorFrontier;

  return update(id, {
    rowCheckpoints: rows,
    rowsProcessed: processed,
    rowsRemaining: Math.max(0, Number(mission.totalEligibleRows || 0) - processed),
    lastProcessedRow: nextFrontier || null,
    nextRow: nextFrontier ? nextFrontier + 1 : mission.nextRow,
    frontierSource: nextFrontier ? 'durable-row-checkpoint' : mission.frontierSource,
    lastSafeCheckpoint: isProcessed
      ? { rowNumber: numericRow, at: now(), state: rows[key].state || 'COMPLETE' }
      : mission.lastSafeCheckpoint,
  });
}

function recordProvenance(id, entries = []) {
  const mission = get(id);
  if (!mission) return null;
  const prior = Array.isArray(mission.provenance) ? mission.provenance : [];
  return update(id, { provenance: [...prior, ...entries].slice(-20000) });
}

function recordCommit(id, entries = []) {
  const state = load();
  const index = state.missions.findIndex((m) => m.missionId === id);
  if (index < 0) return null;

  const mission = state.missions[index];
  const rows = { ...(mission.rowCheckpoints || {}) };
  const at = now();
  let lastVerifiedWriteRow = Number.isInteger(Number(mission.lastVerifiedWriteRow))
    ? Number(mission.lastVerifiedWriteRow)
    : null;

  for (const entry of entries) {
    const rowNumber = Number(entry.rowNumber);
    if (!Number.isInteger(rowNumber)) continue;
    const key = String(rowNumber);
    const prior = rows[key] || {};
    const fields = {
      ...(prior.fields || {}),
      [`${entry.pocOrdinal || 0}:${entry.field}`]: {
        state: 'FOUND',
        source: entry.source,
        verified: true,
      },
    };
    rows[key] = {
      ...prior,
      rowNumber,
      state: prior.state || 'PARTIAL',
      processed: Boolean(prior.processed),
      fields,
      updatedAt: at,
    };
    lastVerifiedWriteRow = Math.max(lastVerifiedWriteRow || 0, rowNumber);
  }

  const processed = processedRows(rows).length;
  const next = {
    ...mission,
    rowCheckpoints: rows,
    rowsProcessed: processed,
    rowsRemaining: Math.max(0, Number(mission.totalEligibleRows || 0) - processed),
    provenance: [
      ...(Array.isArray(mission.provenance) ? mission.provenance : []),
      ...entries,
    ].slice(-20000),
    lastVerifiedWriteRow: lastVerifiedWriteRow || null,
    updatedAt: at,
  };
  state.missions[index] = next;
  save(state);
  return next;
}

function setRecoveredFrontier(id, { lastProcessedRow, nextRow, endRow, source = 'sheet-write-scope-recovery' } = {}) {
  const mission = get(id);
  if (!mission) return null;
  const last = Number(lastProcessedRow);
  const next = Number(nextRow);
  const end = Number(endRow);
  return update(id, {
    lastProcessedRow: Number.isInteger(last) ? last : mission.lastProcessedRow,
    nextRow: Number.isInteger(next) ? next : mission.nextRow,
    endRow: Number.isInteger(end) ? end : mission.endRow,
    frontierSource: source,
    lastSafeCheckpoint: Number.isInteger(last)
      ? { rowNumber: last, at: now(), state: 'RECOVERED_FRONTIER' }
      : mission.lastSafeCheckpoint,
  });
}

function publicSummary(mission) {
  if (!mission) return null;
  const checkpoints = Object.values(mission.rowCheckpoints || {});
  const processed = checkpoints.filter(rowIsProcessed).length;
  const unresolved = checkpoints.filter((row) => row && !rowIsProcessed(row) && row.state && row.state !== 'UNTOUCHED').length;
  const allowed = Array.isArray(mission.writeScope?.allowed) ? mission.writeScope.allowed : [];
  return {
    missionId: mission.missionId,
    provider: mission.provider,
    spreadsheetId: mission.spreadsheetId,
    spreadsheetTitle: mission.spreadsheetTitle,
    sheetName: mission.sheetName,
    sheetId: mission.sheetId,
    schemaFingerprint: mission.schemaFingerprint,
    requestedPOCs: mission.requestedPOCs || [],
    requestedFields: mission.requestedFields || [],
    status: mission.status,
    completionState: mission.completionState,
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
    startedAt: mission.startedAt,
    completedAt: mission.completedAt,
    totalEligibleRows: Number(mission.totalEligibleRows || 0),
    rowsProcessed: Math.max(Number(mission.rowsProcessed || 0), processed),
    rowsRemaining: Number(mission.rowsRemaining || 0),
    checkpointCount: checkpoints.length,
    unresolvedCheckpointCount: unresolved,
    startRow: mission.startRow,
    endRow: mission.endRow,
    lastProcessedRow: mission.lastProcessedRow,
    lastVerifiedWriteRow: mission.lastVerifiedWriteRow,
    nextRow: mission.nextRow,
    frontierSource: mission.frontierSource,
    lastSafeCheckpoint: mission.lastSafeCheckpoint || null,
    approvalId: mission.approvalId || null,
    approvalValid: Boolean(mission.approvalValid),
    nextEligibleAt: mission.nextEligibleAt || null,
    nextEligibleAtSource: mission.nextEligibleAtSource || null,
    apolloUsageLedger: { ...(mission.apolloUsageLedger || {}) },
    providerState: { ...(mission.providerState || {}) },
    writeScope: {
      allowedCount: allowed.length,
      fields: [...new Set(allowed.map((item) => `POC-${item.ordinal} ${item.field}`))],
      protectedColumns: Array.isArray(mission.protectedColumns) ? mission.protectedColumns.length : 0,
    },
    lastError: mission.lastError ? {
      code: mission.lastError.code || null,
      type: mission.lastError.type || null,
      stage: mission.lastError.stage || null,
      nextEligibleAt: mission.lastError.nextEligibleAt || null,
    } : null,
  };
}

function markInterruptedOnStartup() {
  const state = load();
  let changed = false;
  state.missions = state.missions.map((m) => {
    if (m.status === 'RUNNING') {
      changed = true;
      return {
        ...m,
        status: 'INTERRUPTED',
        completionState: 'INTERRUPTED',
        approvalValid: false,
        updatedAt: now(),
      };
    }
    return m;
  });
  if (changed) save(state);
  return changed;
}

module.exports = {
  DIR,
  FILE,
  BACKUP,
  RESUMABLE,
  TERMINAL_ROW_STATES,
  load,
  save,
  create,
  update,
  get,
  list,
  latest,
  byRequestKey,
  latestResumable,
  rowIsProcessed,
  processedRows,
  frontierFromRows,
  checkpointRow,
  recordProvenance,
  recordCommit,
  setRecoveredFrontier,
  publicSummary,
  markInterruptedOnStartup,
};
