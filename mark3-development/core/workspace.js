const crypto = require('crypto');
const path = require('path');
const config = require('./config');
const { readJson, writeJsonAtomic } = require('./persistence');

const FILES = {
  commitment: config.commitmentsPath,
  decision: config.decisionsPath,
  project: config.projectsPath,
  task: path.join(config.dataDir, 'tasks.json'),
  goal: path.join(config.dataDir, 'goals.json'),
  execution: path.join(config.dataDir, 'executions.json'),
};

function normalize(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}
function tokens(value) { return new Set(normalize(value).split(' ').filter((item) => item.length > 1)); }
function overlap(a, b) {
  const A = tokens(a), B = tokens(b); if (!A.size || !B.size) return 0;
  let hit = 0; for (const token of A) if (B.has(token)) hit += 1;
  return hit / Math.max(A.size, B.size);
}
function collection(kind) {
  const file = FILES[kind] || FILES.project;
  return { file, items: readJson(file, []) };
}
function save(kind, items) { writeJsonAtomic(collection(kind).file, items); }
function now() { return new Date().toISOString(); }
function priorityRank(value) { return value === 'critical' ? 0 : value === 'high' ? 1 : value === 'medium' ? 2 : 3; }
function activeStatus(status) { return !['done', 'completed', 'cancelled', 'archived', 'superseded'].includes(String(status || '').toLowerCase()); }
function sameIdentity(a, b) { return normalize(a.title) === normalize(b.title) && normalize(a.project || '') === normalize(b.project || ''); }

function upsertActive(kind, input, defaults = {}) {
  const { items } = collection(kind);
  const candidate = { title: String(input.title || '').trim(), project: input.project || null };
  if (!candidate.title) throw new Error(`${kind} title is required.`);
  const existing = items.find((item) => activeStatus(item.status) && sameIdentity(item, candidate));
  const stamp = now();
  if (existing) {
    Object.assign(existing, input, { updatedAt: stamp });
    save(kind, items);
    return { item: existing, action: 'UPDATED' };
  }
  const item = { id: crypto.randomUUID(), ...defaults, ...input, title: candidate.title, project: candidate.project, createdAt: stamp, updatedAt: stamp };
  items.push(item); save(kind, items); return { item, action: 'CREATED' };
}

function createCommitment(input = {}) {
  return upsertActive('commitment', input, { detail: '', dueAt: null, priority: 'medium', status: 'open', missCount: 0 }).item;
}
function listCommitments(filter = {}) {
  return collection('commitment').items
    .filter((item) => (!filter.status || item.status === filter.status) && (!filter.project || normalize(item.project) === normalize(filter.project)))
    .sort((a, b) => String(a.dueAt || '9999').localeCompare(String(b.dueAt || '9999')) || priorityRank(a.priority) - priorityRank(b.priority));
}
function updateCommitment(id, patch = {}) {
  const { items } = collection('commitment'); const item = items.find(row => row.id === id); if (!item) throw new Error('Commitment not found.');
  Object.assign(item, patch, { updatedAt: now() }); save('commitment', items); return item;
}

function createTask(input = {}) {
  return upsertActive('task', input, { detail: '', dueAt: null, priority: 'medium', status: 'open', blockedBy: null, nextAction: null, source: 'conversation' }).item;
}
function listTasks(filter = {}) {
  return collection('task').items
    .filter((item) => (!filter.status || item.status === filter.status) && (!filter.project || normalize(item.project) === normalize(filter.project)))
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || String(a.dueAt || '9999').localeCompare(String(b.dueAt || '9999')) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}
function updateTask(id, patch = {}) {
  const { items } = collection('task'); const item = items.find(row => row.id === id); if (!item) throw new Error('Task not found.');
  Object.assign(item, patch, { updatedAt: now() }); save('task', items); return item;
}

function createGoal(input = {}) {
  return upsertActive('goal', input, { detail: '', dueAt: null, priority: 'medium', status: 'active', progress: 0, nextAction: null, source: 'conversation' }).item;
}
function listGoals(filter = {}) {
  return collection('goal').items
    .filter((item) => (!filter.status || item.status === filter.status) && (!filter.project || normalize(item.project) === normalize(filter.project)))
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || String(a.dueAt || '9999').localeCompare(String(b.dueAt || '9999')));
}
function updateGoal(id, patch = {}) {
  const { items } = collection('goal'); const item = items.find(row => row.id === id); if (!item) throw new Error('Goal not found.');
  Object.assign(item, patch, { updatedAt: now() }); save('goal', items); return item;
}

function recordDecision(input = {}) {
  const { items } = collection('decision'); const stamp = now();
  const topic = String(input.topic || '').trim(); const decisionText = String(input.decision || '').trim();
  if (!topic || !decisionText) throw new Error('Decision topic and decision are required.');
  const existing = items.find((item) => item.status === 'active' && normalize(item.topic) === normalize(topic) && normalize(item.project || '') === normalize(input.project || ''));
  if (existing) {
    existing.previous = [...(Array.isArray(existing.previous) ? existing.previous : []), existing.decision].slice(-5);
    Object.assign(existing, input, { decision: decisionText, updatedAt: stamp }); save('decision', items); return existing;
  }
  const decision = { id: crypto.randomUUID(), topic, decision: decisionText, reason: String(input.reason || '').trim(), project: input.project || null, status: 'active', createdAt: stamp, updatedAt: stamp };
  items.push(decision); save('decision', items); return decision;
}
function listDecisions(filter = {}) {
  return collection('decision').items.filter(item => (!filter.project || normalize(item.project) === normalize(filter.project)) && item.status !== 'superseded').sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
}

function upsertProject(input = {}) {
  const { items } = collection('project'); const existing = items.find(item => item.id === input.id || normalize(item.name) === normalize(input.name));
  const stamp = now();
  if (existing) { Object.assign(existing, input, { updatedAt: stamp }); save('project', items); return existing; }
  const project = { id: crypto.randomUUID(), name: String(input.name || '').trim(), objective: String(input.objective || '').trim(), stage: input.stage || 'active', status: input.status || 'active', metadata: input.metadata || {}, createdAt: stamp, updatedAt: stamp };
  if (!project.name) throw new Error('Project name is required.'); items.push(project); save('project', items); return project;
}
function listProjects(filter = {}) {
  return collection('project').items.filter((item) => !filter.status || item.status === filter.status).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
}

function bestMatch(query, rows, fields = ['title']) {
  const ranked = rows.map((item) => ({ item, score: overlap(query, fields.map((field) => item[field]).join(' ')) })).sort((a, b) => b.score - a.score);
  return ranked[0] && ranked[0].score >= 0.34 ? ranked[0] : null;
}

function completeMatching(query, project = null) {
  const candidates = [
    ...listTasks().filter((item) => activeStatus(item.status)).map((item) => ({ kind: 'task', item })),
    ...listCommitments().filter((item) => activeStatus(item.status)).map((item) => ({ kind: 'commitment', item })),
    ...listGoals().filter((item) => activeStatus(item.status)).map((item) => ({ kind: 'goal', item })),
  ].filter((row) => !project || normalize(row.item.project || '') === normalize(project));
  const ranked = candidates.map((row) => ({ ...row, score: overlap(query, `${row.item.title} ${row.item.detail || ''} ${row.item.project || ''}`) })).sort((a, b) => b.score - a.score);
  const match = ranked[0];
  if (!match || match.score < 0.28) return null;
  if (match.kind === 'task') updateTask(match.item.id, { status: 'completed', completedAt: now() });
  else if (match.kind === 'commitment') updateCommitment(match.item.id, { status: 'completed', completedAt: now() });
  else updateGoal(match.item.id, { status: 'completed', progress: 100, completedAt: now() });
  return { kind: match.kind, item: match.item, score: match.score };
}

function recordExecution(input = {}) {
  const { items } = collection('execution'); const stamp = now();
  const execution = { id: crypto.randomUUID(), objective: String(input.objective || '').trim(), taskType: input.taskType || 'general', planId: input.planId || null, status: input.status || 'executing', verification: null, evidence: [], error: null, createdAt: stamp, updatedAt: stamp, completedAt: null };
  items.push(execution); save('execution', items); return execution;
}
function updateExecution(id, patch = {}) {
  const { items } = collection('execution'); const item = items.find((row) => row.id === id); if (!item) throw new Error('Execution not found.');
  Object.assign(item, patch, { updatedAt: now() }); if (['verified', 'failed', 'partial'].includes(item.status) && !item.completedAt) item.completedAt = now();
  save('execution', items); return item;
}
function listExecutions(limit = 20) { return collection('execution').items.sort((a,b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, Math.max(1, limit)); }

function stateSnapshot(options = {}) {
  const activeProjects = listProjects().filter((item) => activeStatus(item.status));
  const goals = listGoals().filter((item) => activeStatus(item.status));
  const tasks = listTasks().filter((item) => activeStatus(item.status));
  const commitments = listCommitments().filter((item) => activeStatus(item.status));
  const decisions = listDecisions().slice(0, 12);
  const blocked = tasks.filter((item) => item.status === 'blocked' || item.blockedBy);
  const actionable = [...tasks, ...commitments]
    .filter((item) => item.status !== 'blocked')
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || String(a.dueAt || '9999').localeCompare(String(b.dueAt || '9999')));
  const query = String(options.query || '').trim();
  const relevant = query ? {
    projects: activeProjects.filter((item) => overlap(query, `${item.name} ${item.objective || ''}`) >= 0.18).slice(0, 5),
    goals: goals.filter((item) => overlap(query, `${item.title} ${item.detail || ''} ${item.project || ''}`) >= 0.18).slice(0, 6),
    tasks: tasks.filter((item) => overlap(query, `${item.title} ${item.detail || ''} ${item.project || ''}`) >= 0.18).slice(0, 8),
  } : null;
  return {
    generatedAt: now(),
    projects: activeProjects,
    goals,
    tasks,
    commitments,
    decisions,
    blocked,
    waitingFor: blocked.map((item) => ({ id: item.id, title: item.title, blockedBy: item.blockedBy, project: item.project })),
    topAction: actionable[0] || null,
    counts: { projects: activeProjects.length, goals: goals.length, tasks: tasks.length, commitments: commitments.length, blocked: blocked.length },
    relevant,
  };
}

function renderBriefing(snapshot = stateSnapshot()) {
  const lines = [];
  const urgent = [...snapshot.tasks, ...snapshot.commitments].filter((item) => item.priority === 'critical' || item.priority === 'high').slice(0, 3);
  if (snapshot.topAction) lines.push(`First priority: ${snapshot.topAction.title}${snapshot.topAction.project ? ` (${snapshot.topAction.project})` : ''}.`);
  if (urgent.length > 1) lines.push(`Other important items: ${urgent.slice(1).map((item) => item.title).join('; ')}.`);
  if (snapshot.blocked.length) lines.push(`Blocked: ${snapshot.blocked.slice(0, 2).map((item) => `${item.title}${item.blockedBy ? ` — waiting on ${item.blockedBy}` : ''}`).join('; ')}.`);
  if (!lines.length) lines.push('No active high-priority work is recorded.');
  return lines.join(' ');
}

function applyMutation(mutation = {}) {
  if (!mutation || !mutation.type) return null;
  if (mutation.type === 'create_task') return { type: mutation.type, item: createTask(mutation) };
  if (mutation.type === 'create_goal') return { type: mutation.type, item: createGoal(mutation) };
  if (mutation.type === 'create_commitment') return { type: mutation.type, item: createCommitment(mutation) };
  if (mutation.type === 'complete') return { type: mutation.type, match: completeMatching(mutation.query || mutation.title, mutation.project) };
  if (mutation.type === 'upsert_project') return { type: mutation.type, item: upsertProject(mutation) };
  return null;
}

module.exports = {
  createCommitment, listCommitments, updateCommitment,
  createTask, listTasks, updateTask,
  createGoal, listGoals, updateGoal,
  recordDecision, listDecisions,
  upsertProject, listProjects,
  completeMatching, recordExecution, updateExecution, listExecutions,
  stateSnapshot, renderBriefing, applyMutation, overlap,
};
