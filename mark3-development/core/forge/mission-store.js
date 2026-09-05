const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const { readJson, writeJsonAtomic, appendJsonl } = require('../persistence');

const ROOT = path.join(config.projectRoot, '.ultron', 'forge');
const MISSIONS = path.join(ROOT, 'missions');
const WORKSPACES = path.join(ROOT, 'workspaces');

function ensureRoot() {
  fs.mkdirSync(MISSIONS, { recursive: true });
  fs.mkdirSync(WORKSPACES, { recursive: true });
}
function slug(text) {
  return String(text || 'mission').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 42) || 'mission';
}
function newId(objective) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `${stamp}-${slug(objective)}-${crypto.randomBytes(2).toString('hex')}`;
}
function missionDir(id) { ensureRoot(); return path.join(MISSIONS, String(id)); }
function missionFile(id) { return path.join(missionDir(id), 'mission.json'); }
function jobsFile(id) { return path.join(missionDir(id), 'jobs.json'); }
function agentsFile(id) { return path.join(missionDir(id), 'agents.json'); }
function usageFile(id) { return path.join(missionDir(id), 'usage.json'); }
function eventsFile(id) { return path.join(missionDir(id), 'events.jsonl'); }
function workspacePath(id) { ensureRoot(); const dir = path.join(WORKSPACES, String(id)); fs.mkdirSync(dir, { recursive: true }); return dir; }

function create(objective, options = {}) {
  ensureRoot();
  const id = newId(objective);
  const now = new Date().toISOString();
  const mission = {
    id,
    objective: String(objective || '').trim(),
    status: 'created',
    phase: 'compile',
    createdAt: now,
    updatedAt: now,
    workspace: options.workspace || workspacePath(id),
    source: options.source || 'conversation',
    forgeProfile: options.forgeProfile || null,
    constraints: {
      zeroCostOnly: true,
      localLlmAllowed: false,
      paidInferenceAllowed: false,
      requireApprovalForExternalSideEffects: true,
      ...(options.constraints || {}),
    },
    progress: { total: 0, completed: 0, failed: 0, running: 0, percent: 0 },
  };
  writeJsonAtomic(missionFile(id), mission);
  writeJsonAtomic(jobsFile(id), []);
  writeJsonAtomic(agentsFile(id), []);
  writeJsonAtomic(usageFile(id), { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, byModel: {}, byKeySlot: {} });
  event(id, 'mission_created', { objective: mission.objective, workspace: mission.workspace, forgeProfile: mission.forgeProfile });
  return mission;
}
function load(id) { return readJson(missionFile(id), null); }
function save(mission) {
  if (!mission?.id) throw new Error('Mission id is required.');
  const value = { ...mission, updatedAt: new Date().toISOString() };
  writeJsonAtomic(missionFile(mission.id), value);
  return value;
}
function jobs(id) { return readJson(jobsFile(id), []); }
function saveJobs(id, value) { writeJsonAtomic(jobsFile(id), Array.isArray(value) ? value : []); return value; }
function agents(id) { return readJson(agentsFile(id), []); }
function saveAgents(id, value) { writeJsonAtomic(agentsFile(id), Array.isArray(value) ? value : []); return value; }
function usage(id) { return readJson(usageFile(id), { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, byModel: {}, byKeySlot: {} }); }
function saveUsage(id, value) { writeJsonAtomic(usageFile(id), value); return value; }
function event(id, type, data = {}) { appendJsonl(eventsFile(id), { at: new Date().toISOString(), type, ...data }); }
function checkpoint(id, patch = {}) {
  const current = load(id);
  if (!current) throw new Error(`Mission ${id} was not found.`);
  const next = save({ ...current, ...patch });
  event(id, 'checkpoint', { status: next.status, phase: next.phase, progress: next.progress, forgeProfile: next.forgeProfile || null });
  return next;
}
function list(limit = 20) {
  ensureRoot();
  return fs.readdirSync(MISSIONS, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => load(entry.name)).filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, limit);
}

module.exports = { ROOT, MISSIONS, WORKSPACES, create, load, save, jobs, saveJobs, agents, saveAgents, usage, saveUsage, event, checkpoint, list, workspacePath };
