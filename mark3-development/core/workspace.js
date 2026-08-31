const crypto = require('crypto');
const config = require('./config');
const { readJson, writeJsonAtomic } = require('./persistence');

function collection(kind) {
  const file = kind === 'commitment' ? config.commitmentsPath : kind === 'decision' ? config.decisionsPath : config.projectsPath;
  return { file, items: readJson(file, []) };
}

function save(kind, items) { writeJsonAtomic(collection(kind).file, items); }

function createCommitment(input = {}) {
  const { items } = collection('commitment');
  const now = new Date().toISOString();
  const item = { id: crypto.randomUUID(), title: String(input.title || '').trim(), detail: String(input.detail || '').trim(), dueAt: input.dueAt || null, priority: input.priority || 'medium', status: 'open', project: input.project || null, createdAt: now, updatedAt: now, missCount: 0 };
  if (!item.title) throw new Error('Commitment title is required.');
  items.push(item); save('commitment', items); return item;
}

function listCommitments(filter = {}) {
  const { items } = collection('commitment');
  return items.filter(item => !filter.status || item.status === filter.status).sort((a, b) => String(a.dueAt || '9999').localeCompare(String(b.dueAt || '9999')));
}

function updateCommitment(id, patch = {}) {
  const { items } = collection('commitment'); const item = items.find(row => row.id === id); if (!item) throw new Error('Commitment not found.');
  Object.assign(item, patch, { updatedAt: new Date().toISOString() });
  save('commitment', items); return item;
}

function recordDecision(input = {}) {
  const { items } = collection('decision'); const now = new Date().toISOString();
  const decision = { id: crypto.randomUUID(), topic: String(input.topic || '').trim(), decision: String(input.decision || '').trim(), reason: String(input.reason || '').trim(), project: input.project || null, status: 'active', createdAt: now, updatedAt: now };
  if (!decision.topic || !decision.decision) throw new Error('Decision topic and decision are required.');
  items.push(decision); save('decision', items); return decision;
}

function listDecisions(filter = {}) { const { items } = collection('decision'); return items.filter(item => !filter.project || item.project === filter.project).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)); }
function upsertProject(input = {}) {
  const { items } = collection('project'); const existing = items.find(item => item.id === input.id || item.name === input.name);
  const now = new Date().toISOString();
  if (existing) { Object.assign(existing, input, { updatedAt: now }); save('project', items); return existing; }
  const project = { id: crypto.randomUUID(), name: String(input.name || '').trim(), objective: String(input.objective || '').trim(), stage: input.stage || 'active', status: 'active', metadata: input.metadata || {}, createdAt: now, updatedAt: now };
  if (!project.name) throw new Error('Project name is required.'); items.push(project); save('project', items); return project;
}
function listProjects() { return collection('project').items.sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)); }
module.exports = { createCommitment, listCommitments, updateCommitment, recordDecision, listDecisions, upsertProject, listProjects };
