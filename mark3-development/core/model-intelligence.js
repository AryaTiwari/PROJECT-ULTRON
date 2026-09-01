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

// Devin/DVA agentic bridge models are intentionally removed from Mark 3.
function isDevinModel(id) {
  const value = String(id || '').trim().toLowerCase();
  if (!value) return false;
  const segments = value.split(/[\\/_-]+/).filter(Boolean);
  return segments.includes('dva') || segments.includes('devin') || segments.includes('agentic') || segments.includes('bridge');
}

function isRoutingAlias(id) {
  const value = String(id || '').trim().toLowerCase();
  if (!value) return true;
  if (/^auto(?:\/|$)/i.test(value)) return true;
  if (/^omniroute\//i.test(value)) return true;
  if (/^(?:oc|opencode)(?:\/|$)/i.test(value)) return true;
  if (/^no-think(?:\/|$)/i.test(value)) return true;
  return false;
}

function isBigPickle(id) { return /big[-_ ]?pickle/i.test(String(id || '')); }

function isAssistantEligibleModel(id) {
  const value = String(id || '').trim();
  if (!value || isDevinModel(value) || isBigPickle(value) || isRoutingAlias(value)) return false;
  return true;
}

async function catalog() {
  if (!parentRouter || typeof parentRouter.listModels !== 'function') throw new Error('Shared OmniRoute router is unavailable.');
  try {
    const models = await parentRouter.listModels({ force: true });
    const raw = [...new Set((models || []).map(String).map(value => value.trim()).filter(Boolean))];
    const eligible = raw.filter(isAssistantEligibleModel);
    if (!eligible.length) throw new Error('OmniRoute catalog returned no non-Devin provider models.');
    return {
      models: eligible,
      count: eligible.length,
      rawCount: raw.length,
      devinExcludedCount: raw.filter(isDevinModel).length,
      source: 'shared-omniroute-router-provider-catalog',
    };
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    throw new Error(`OmniRoute model catalog unavailable: ${diagnostic}`);
  }
}

async function intelligence(taskType = null) {
  const live = await catalog();
  const observed = summarize(taskType);
  return { live, observed, generatedAt: new Date().toISOString() };
}

module.exports = {
  record,
  history,
  summarize,
  catalog,
  intelligence,
  isRoutingAlias,
  isDevinModel,
  isBigPickle,
  isAssistantEligibleModel,
};
