'use strict';
const fs = require('fs'); const path = require('path'); const crypto = require('crypto'); const config = require('./config'); const contract = require('./apollo-lead-contract');
const FILE = path.join(config.projectRoot, '.ultron', 'apollo-lead-missions.json');
function load() { try { const v = JSON.parse(fs.readFileSync(FILE, 'utf8')); return { missions: Array.isArray(v.missions) ? v.missions : [] }; } catch { return { missions: [] }; } }
function save(state) { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify({ missions: (state.missions || []).slice(-50) }, null, 2)); }
function create(compiled) {
  const state = load();
  const now = new Date().toISOString();
  const mission = {
    missionId: `apollo-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    missionType: compiled.missionType,
    contractVersion: contract.VERSION,
    runtimeBuildId: contract.runtimeBuild.id,
    runtimeRevision: contract.runtimeBuild.revision,
    runtimeSourceFingerprint: contract.runtimeBuild.fingerprint,
    query: compiled.query,
    entityType: compiled.entityType,
    targetCount: compiled.targetCount,
    compiledFilters: compiled,
    companyCandidatesFound: 0,
    companiesQualified: 0,
    companiesRejected: 0,
    companiesSelected: 0,
    reserveCount: compiled.reserveCount || 0,
    searchVariantsTried: 0,
    currentSearchVariant: null,
    peopleDiscovered: 0,
    peopleVerified: 0,
    phoneAvailabilityChecked: 0,
    phoneReveals: 0,
    emailReveals: 0,
    POC1Selected: 0,
    POC2Selected: 0,
    companiesReplacedForContactability: 0,
    cacheHits: 0,
    apolloCalls: 0,
    paidCalls: 0,
    rowsWritten: 0,
    skippedDuplicates: 0,
    sheetName: compiled.sheet?.sheetName || null,
    sheetUrl: compiled.sheet?.url || null,
    currentPhase: 'created',
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
function update(id, patch = {}) { const state = load(); const index = state.missions.findIndex((m) => m.missionId === id); if (index < 0) return null; state.missions[index] = { ...state.missions[index], ...patch, updatedAt: new Date().toISOString() }; save(state); return state.missions[index]; }
function get(id) { return load().missions.find((m) => m.missionId === id) || null; }
function latest() { return load().missions.at(-1) || null; }
module.exports = { FILE, load, save, create, update, get, latest };
