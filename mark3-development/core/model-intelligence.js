const fs = require('fs');
const config = require('./config');
const { appendJsonl, readJsonl } = require('./persistence');

function record(event = {}) {
  appendJsonl(config.performancePath, { provider: event.provider || 'unknown', model: event.model || 'unknown', taskType: event.taskType || 'general', success: Boolean(event.success), latencyMs: Number(event.latencyMs) || null, qualityScore: Number.isFinite(Number(event.qualityScore)) ? Number(event.qualityScore) : null, reason: event.reason || null, at: new Date().toISOString() });
}

function history() { return readJsonl(config.performancePath); }
function summarize(taskType = null) {
  const rows = history().filter(row => !taskType || row.taskType === taskType);
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.provider}::${row.model}`;
    const g = groups.get(key) || { provider: row.provider, model: row.model, attempts: 0, successes: 0, latency: [], quality: [] };
    g.attempts += 1; if (row.success) g.successes += 1; if (Number.isFinite(row.latencyMs)) g.latency.push(row.latencyMs); if (Number.isFinite(row.qualityScore)) g.quality.push(row.qualityScore); groups.set(key, g);
  }
  return [...groups.values()].map(g => ({ provider: g.provider, model: g.model, attempts: g.attempts, successRate: g.attempts ? g.successes / g.attempts : 0, averageLatencyMs: g.latency.length ? g.latency.reduce((a,b)=>a+b,0)/g.latency.length : null, averageQuality: g.quality.length ? g.quality.reduce((a,b)=>a+b,0)/g.quality.length : null }));
}

async function catalog(baseUrl = config.omnirouteBase) {
  const response = await fetch(`${baseUrl}/models`, { headers: config.omnirouteApiKey ? { Authorization: `Bearer ${config.omnirouteApiKey}` } : undefined });
  const body = await response.text(); let data = {}; try { data = body ? JSON.parse(body) : {}; } catch {}
  if (!response.ok) throw new Error(`Model catalog HTTP ${response.status}: ${body.slice(0, 500)}`);
  const models = (Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : []).map(item => typeof item === 'string' ? item : item?.id || item?.model || item?.name).filter(Boolean);
  return { models, count: models.length };
}

async function intelligence(taskType = null) {
  const live = await catalog();
  const known = summarize(taskType);
  return { live, observed: known, generatedAt: new Date().toISOString() };
}

module.exports = { record, history, summarize, catalog, intelligence };
