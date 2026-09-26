'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const contract = require('./apollo-lead-contract');

const FILE = path.join(config.projectRoot, '.ultron', 'apollo-lead-missions.json');
function load() {
  try {
    const value = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { missions: Array.isArray(value.missions) ? value.missions : [] };
  } catch { return { missions: [] }; }
}
function save(state) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const payload = JSON.stringify({ missions: (state.missions || []).slice(-50) }, null, 2);
  const temp = `${FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, payload, { mode: 0o600 });
  fs.renameSync(temp, FILE);
  try { fs.chmodSync(FILE, 0o600); } catch {}
}
function create(compiled) {
  const state = load();
  const now = new Date().toISOString();
  const sheet = compiled.sheet || {};
  const mission = {
    missionId: `apollo-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    missionType: compiled.missionType,
    contractVersion: contract.VERSION,
    runtimeBuild: contract.runtimeBuild,
    runtimeBuildId: contract.runtimeBuild.id,
    runtimeRevision: contract.runtimeBuild.revision,
    runtimeSourceFingerprint: contract.runtimeBuild.fingerprint,
    query: compiled.query,
    entityType: compiled.entityType,
    targetCount: compiled.targetCount,
    compiledRequirements: compiled,
    compiledFilters: compiled,
    worksheetUrl: sheet.url || null,
    sheetUrl: sheet.url || null,
    spreadsheetId: sheet.spreadsheetId || null,
    sheetId: sheet.sheetId ?? null,
    exactWorksheetTitle: sheet.exactTitle || sheet.sheetName || null,
    sheetName: sheet.exactTitle || sheet.sheetName || null,
    searchVariants: [],
    searchDiagnostics: [],
    candidateCompanies: [],
    qualifiedCompanies: [],
    companiesWritten: 0,
    companiesAlreadyExisting: 0,
    companyCandidatesFound: 0,
    companiesQualified: 0,
    companiesSelected: 0,
    candidatePoolTarget: 0,
    apolloOrganizationIds: [],
    peopleSearched: 0,
    peopleDiscovered: 0,
    peopleVerified: 0,
    pocShortlist: [],
    pocsSelected: [],
    POC1Selected: 0,
    POC2Selected: 0,
    indianPhoneAttempts: 0,
    foreignFallbacks: 0,
    phoneAvailabilityChecked: 0,
    phonesFilled: 0,
    emailsFilled: 0,
    unresolvedContactSlots: 0,
    pendingRevealIds: [],
    cacheHits: 0,
    organizationSearchCalls: 0,
    peopleSearchCalls: 0,
    contactRevealCalls: 0,
    apolloSearchCalls: 0,
    apolloRevealCalls: 0,
    apolloCalls: 0,
    paidCalls: 0,
    phoneReveals: 0,
    emailReveals: 0,
    rowsWritten: 0,
    companyFieldsWritten: 0,
    skippedDuplicates: 0,
    approvalId: null,
    currentPhase: 'created',
    completionState: 'created',
    remainingTarget: compiled.targetCount,
    completionReason: null,
    safetyState: 'approval_required',
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
  state.missions.push(mission);
  save(state);
  return mission;
}
function update(id, patch = {}) {
  const state = load();
  const index = state.missions.findIndex((mission) => mission.missionId === id);
  if (index < 0) return null;
  const phase = patch.currentPhase || state.missions[index].currentPhase;
  state.missions[index] = {
    ...state.missions[index],
    ...patch,
    completionState: patch.completionState || phase,
    updatedAt: new Date().toISOString(),
  };
  save(state);
  return state.missions[index];
}
function get(id) { return load().missions.find((mission) => mission.missionId === id) || null; }
function latest() { return load().missions.at(-1) || null; }
module.exports = { FILE, load, save, create, update, get, latest };
