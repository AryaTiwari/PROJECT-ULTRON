const config = require('./config');
const { readJson, writeJsonAtomic } = require('./persistence');

const VERSION = 1;
const BACKUP_COUNT = Math.max(1, Number(process.env.ULTRON_M3_LEAGUE_BACKUPS || 3));
const RETEST_AFTER_MS = Math.max(60 * 60 * 1000, Number(process.env.ULTRON_M3_LEAGUE_RETEST_MS || 24 * 60 * 60 * 1000));
const DIRECT_ENV_KEYS = [
  'GEMINI_API_KEY', 'GEMINI_API_KEY2', 'GOOGLE_API_KEY', 'GOOGLE_API_KEY2',
  'GROQ_API_KEY', 'GROQ_API_KEY2',
  'NVIDIA_API_KEY', 'NVIDIA_API_KEY2', 'NVIDIA_NIM_API_KEY',
];

function directConfigured() {
  if (/^(0|false|no|off)$/i.test(String(process.env.ULTRON_M3_DIRECT_ENABLED || '1'))) return false;
  return DIRECT_ENV_KEYS.some((name) => String(process.env[name] || '').trim());
}

function isDirectModel(model) {
  return /^(?:gemini|groq|nvidia)\//i.test(String(model || '').trim());
}

function directOnly(rows) {
  return directConfigured() ? rows.filter((row) => isDirectModel(row.model || row)) : rows;
}

function template() {
  return {
    version: VERSION,
    tasks: {},
    updatedAt: null,
  };
}

function load() {
  const state = readJson(config.modelLeaguePath, template());
  if (!state || typeof state !== 'object' || state.version !== VERSION) return template();
  state.tasks ||= {};
  return state;
}

function save(state) {
  state.version = VERSION;
  state.updatedAt = new Date().toISOString();
  writeJsonAtomic(config.modelLeaguePath, state);
}

function taskKey(taskType = 'general') {
  const task = String(taskType || 'general').trim().toLowerCase();
  return task || 'general';
}

function taskState(state, taskType = 'general') {
  const key = taskKey(taskType);
  state.tasks[key] ||= {
    primary: null,
    backups: [],
    models: {},
    rounds: 0,
    lastTournamentAt: null,
    lastPromotionAt: null,
  };
  state.tasks[key].models ||= {};
  state.tasks[key].backups ||= [];
  return state.tasks[key];
}

function latencyScore(ms) {
  const latency = Number(ms);
  if (!Number.isFinite(latency) || latency <= 0) return 0.5;
  if (latency <= 2500) return 1;
  if (latency >= 30000) return 0;
  return Math.max(0, 1 - ((latency - 2500) / 27500));
}

function utility(row = {}) {
  const attempts = Number(row.attempts || 0);
  const successes = Number(row.successes || 0);
  const qualitySamples = Number(row.qualitySamples || 0);
  const averageQuality = qualitySamples ? Number(row.qualityTotal || 0) / qualitySamples : 0.5;
  const reliability = attempts ? successes / attempts : 0.5;
  const speed = latencyScore(row.averageLatencyMs);
  const evidence = Math.min(1, attempts / 4);
  const base = (averageQuality * 0.58) + (reliability * 0.32) + (speed * 0.10);
  return Math.max(0, Math.min(1, (base * (0.75 + 0.25 * evidence))));
}

function ranked(taskType = 'general') {
  const state = load();
  const task = taskState(state, taskType);
  return Object.entries(task.models)
    .map(([model, row]) => ({ model, ...row, utility: utility(row) }))
    .filter((row) => Number(row.successes || 0) > 0)
    .sort((a, b) => b.utility - a.utility
      || Number(b.lastQuality || 0) - Number(a.lastQuality || 0)
      || Number(a.averageLatencyMs || Infinity) - Number(b.averageLatencyMs || Infinity));
}

function recommend(taskType = 'general') {
  const state = load();
  const task = taskState(state, taskType);
  const allRanked = ranked(taskType);
  const list = directOnly(allRanked);
  const storedPrimary = task.primary && (!directConfigured() || isDirectModel(task.primary)) ? task.primary : null;
  const primary = storedPrimary && list.some((row) => row.model === storedPrimary)
    ? storedPrimary
    : list[0]?.model || null;
  const backups = [
    ...(task.backups || []).filter((model) => !directConfigured() || isDirectModel(model)),
    ...list.map((row) => row.model),
  ].filter((model, index, all) => model && model !== primary && all.indexOf(model) === index)
    .slice(0, BACKUP_COUNT);
  return {
    taskType: taskKey(taskType),
    primary,
    backups,
    ranked: list.slice(0, BACKUP_COUNT + 3),
    rounds: Number(task.rounds || 0),
    lastTournamentAt: task.lastTournamentAt || null,
    transportPolicy: directConfigured() ? 'direct-only-learning' : 'all-eligible-models',
  };
}

function updateAverage(current, next, previousCount) {
  const value = Number(next);
  if (!Number.isFinite(value)) return current ?? null;
  const count = Math.max(0, Number(previousCount || 0));
  if (!Number.isFinite(Number(current)) || count <= 0) return value;
  return ((Number(current) * count) + value) / (count + 1);
}

function recordTrial({ model, provider = 'unknown', taskType = 'general', success, quality = null, latencyMs = null, error = null, tournament = false } = {}) {
  const id = String(model || '').trim();
  if (!id) return null;
  const state = load();
  const task = taskState(state, taskType);
  const row = task.models[id] || {
    provider,
    attempts: 0,
    successes: 0,
    failures: 0,
    qualitySamples: 0,
    qualityTotal: 0,
    averageLatencyMs: null,
    lastQuality: null,
    lastTriedAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
    tournamentTrials: 0,
  };
  const previousLatencySamples = Number(row.latencySamples || 0);
  row.provider = provider || row.provider || 'unknown';
  row.attempts += 1;
  if (success) {
    row.successes += 1;
    row.lastSuccessAt = new Date().toISOString();
    row.lastError = null;
  } else {
    row.failures += 1;
    row.lastFailureAt = new Date().toISOString();
    row.lastError = String(error || '').slice(0, 500) || null;
  }
  if (Number.isFinite(Number(latencyMs))) {
    row.averageLatencyMs = updateAverage(row.averageLatencyMs, Number(latencyMs), previousLatencySamples);
    row.latencySamples = previousLatencySamples + 1;
  }
  if (Number.isFinite(Number(quality))) {
    const score = Math.max(0, Math.min(1, Number(quality)));
    row.qualitySamples += 1;
    row.qualityTotal += score;
    row.lastQuality = score;
  }
  if (tournament) row.tournamentTrials += 1;
  row.lastTriedAt = new Date().toISOString();
  task.models[id] = row;
  save(state);
  return { model: id, ...row, utility: utility(row) };
}

function promote(taskType = 'general') {
  const state = load();
  const task = taskState(state, taskType);
  const all = Object.entries(task.models)
    .map(([model, row]) => ({ model, ...row, utility: utility(row) }))
    .filter((row) => Number(row.successes || 0) > 0)
    .sort((a, b) => b.utility - a.utility
      || Number(b.lastQuality || 0) - Number(a.lastQuality || 0)
      || Number(a.averageLatencyMs || Infinity) - Number(b.averageLatencyMs || Infinity));
  const list = directOnly(all);
  const previous = task.primary || null;
  task.primary = list[0]?.model || null;
  task.backups = list.slice(1, BACKUP_COUNT + 1).map((row) => row.model);
  task.lastPromotionAt = new Date().toISOString();
  if (previous !== task.primary) task.primaryChangedAt = task.lastPromotionAt;
  save(state);
  return { previous, ...recommend(taskType) };
}

function markTournament(taskType = 'general') {
  const state = load();
  const task = taskState(state, taskType);
  task.rounds = Number(task.rounds || 0) + 1;
  task.lastTournamentAt = new Date().toISOString();
  save(state);
}

function selectParticipants(catalog = [], taskType = 'general', limit = 4) {
  const state = load();
  const task = taskState(state, taskType);
  const rec = recommend(taskType);
  const now = Date.now();
  let unique = [...new Set((catalog || []).map(String).map((value) => value.trim()).filter(Boolean))];
  if (directConfigured()) unique = unique.filter(isDirectModel);
  const rows = unique.map((model) => {
    const observed = task.models[model] || {};
    const triedAt = Date.parse(observed.lastTriedAt || '');
    const neverTried = !Number(observed.attempts || 0);
    const stale = !Number.isFinite(triedAt) || now - triedAt >= RETEST_AFTER_MS;
    return { model, observed, neverTried, stale, utility: utility(observed) };
  });

  const selected = [];
  if (rec.primary && unique.includes(rec.primary)) selected.push(rec.primary);

  const unseen = rows.filter((row) => row.neverTried && row.model !== rec.primary);
  const stale = rows.filter((row) => !row.neverTried && row.stale && row.model !== rec.primary)
    .sort((a, b) => a.utility - b.utility);
  const proven = rows.filter((row) => !row.neverTried && !row.stale && row.model !== rec.primary)
    .sort((a, b) => b.utility - a.utility);

  for (const row of [...unseen, ...stale, ...proven]) {
    if (selected.length >= Math.max(2, Number(limit || 4))) break;
    if (!selected.includes(row.model)) selected.push(row.model);
  }
  return selected;
}

function snapshot() {
  const state = load();
  const tasks = {};
  for (const key of Object.keys(state.tasks || {})) tasks[key] = recommend(key);
  return { version: VERSION, tasks, updatedAt: state.updatedAt || null, directOnly: directConfigured() };
}

module.exports = {
  recommend,
  ranked,
  recordTrial,
  promote,
  markTournament,
  selectParticipants,
  snapshot,
  utility,
  isDirectModel,
  directConfigured,
};
