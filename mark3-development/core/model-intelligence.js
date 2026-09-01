const config = require('./config');
const { appendJsonl, readJsonl } = require('./persistence');
let parentRouter = null;
try { parentRouter = require('../../core/omniroute'); } catch (_) { parentRouter = null; }

function record(event = {}) {
  appendJsonl(config.performancePath, {
    provider: event.provider || 'unknown',
    model: event.model || 'unknown',
    taskType: event.taskType || 'general',
    success: Boolean(event.success),
    latencyMs: Number(event.latencyMs) || null,
    qualityScore: Number.isFinite(Number(event.qualityScore)) ? Number(event.qualityScore) : null,
    reason: event.reason || null,
    at: new Date().toISOString(),
  });
}

function history() { return readJsonl(config.performancePath); }

function summarize(taskType = null) {
  const rows = history().filter(row => !taskType || row.taskType === taskType);
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.provider}::${row.model}`;
    const group = groups.get(key) || { provider: row.provider, model: row.model, attempts: 0, successes: 0, latency: [], quality: [] };
    group.attempts += 1;
    if (row.success) group.successes += 1;
    if (Number.isFinite(row.latencyMs)) group.latency.push(row.latencyMs);
    if (Number.isFinite(row.qualityScore)) group.quality.push(row.qualityScore);
    groups.set(key, group);
  }
  return [...groups.values()].map(group => ({
    provider: group.provider,
    model: group.model,
    attempts: group.attempts,
    successRate: group.attempts ? group.successes / group.attempts : 0,
    averageLatencyMs: group.latency.length ? group.latency.reduce((a, b) => a + b, 0) / group.latency.length : null,
    averageQuality: group.quality.length ? group.quality.reduce((a, b) => a + b, 0) / group.quality.length : null,
  }));
}

async function catalog() {
  if (!parentRouter || typeof parentRouter.listModels !== 'function') {
    throw new Error('Parent OmniRoute router is unavailable; refusing unauthenticated direct catalog fallback.');
  }
  try {
    const models = await parentRouter.listModels({ force: true });
    const normalized = [...new Set((models || []).map(String).map(value => value.trim()).filter(Boolean))];
    return {
      models: normalized,
      count: normalized.length,
      source: 'parent-omniroute-router',
    };
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    let health = null;
    try {
      if (typeof parentRouter.health === 'function') health = await parentRouter.health();
    } catch (_) {}
    if (health?.ok && Array.isArray(health.catalogSample)) {
      return {
        models: [...new Set(health.catalogSample.map(String).map(value => value.trim()).filter(Boolean))],
        count: Number(health.modelCount) || health.catalogSample.length,
        source: 'parent-omniroute-health-sample',
        degraded: true,
      };
    }
    throw new Error(`Parent OmniRoute router catalog failed: ${diagnostic}`);
  }
}

async function intelligence(taskType = null) {
  const live = await catalog();
  const observed = summarize(taskType);
  return { live, observed, generatedAt: new Date().toISOString() };
}

module.exports = { record, history, summarize, catalog, intelligence };
