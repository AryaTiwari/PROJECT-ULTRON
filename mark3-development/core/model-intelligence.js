const fs = require('fs');
const path = require('path');
const config = require('./config');
const { appendJsonl, readJsonl } = require('./persistence');
let parentRouter = null;
try { parentRouter = require('../../core/omniroute'); } catch (_) { parentRouter = null; }

const KNOWLEDGE_PATH = path.join(config.root, 'core', 'model-knowledge.json');

function loadKnowledge() {
  try {
    const data = JSON.parse(fs.readFileSync(KNOWLEDGE_PATH, 'utf8'));
    return Array.isArray(data.models) ? data.models : [];
  } catch {
    return [];
  }
}

const KNOWLEDGE = loadKnowledge();

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
  if (/^no-think(?:\/|$)/i.test(value)) return true;
  // OpenCode provider models are real provider endpoints, not routing aliases.
  if (/^oc(?:\/|$)/i.test(value)) return true;
  return false;
}

function isBigPickle(id) { return /big[-_ ]?pickle/i.test(String(id || '')); }

function isAssistantEligibleModel(id) {
  const value = String(id || '').trim();
  if (!value || isDevinModel(value) || isBigPickle(value) || isRoutingAlias(value)) return false;
  return true;
}

function providerFromModel(modelId) {
  const first = String(modelId || '').split('/')[0].trim().toLowerCase();
  if (!first) return 'unknown';
  const aliases = { opencode: 'opencode', pollinations: 'pollinations', nvidia: 'nvidia', zenmux: 'zenmux', bytez: 'bytez', vertex: 'vertex' };
  return aliases[first] || first;
}

function knowledgeFor(modelId) {
  const value = String(modelId || '').trim().toLowerCase();
  if (!value) return null;
  return KNOWLEDGE.find(entry => Array.isArray(entry.patterns) && entry.patterns.some(pattern => value === String(pattern).toLowerCase() || value.includes(String(pattern).toLowerCase()))) || null;
}

function suitability(modelId, taskType = 'general') {
  const entry = knowledgeFor(modelId);
  if (!entry) return { score: 0, reason: 'No curated profile; rely on live performance history.' };
  const task = String(taskType || 'general').toLowerCase();
  const strengths = (entry.strengths || []).map(String).map(v => v.toLowerCase());
  const keywordMap = {
    coding: ['coding', 'tool use', 'agents'],
    debugging: ['coding', 'reasoning', 'tool use', 'agents'],
    research: ['reasoning', 'long context', 'general chat'],
    multimodal: ['multimodal', 'vision', 'video', 'image'],
    planning: ['planning', 'reasoning', 'agents', 'tool calling'],
    general: ['general assistant', 'general intelligence', 'reasoning', 'chat']
  };
  const wanted = keywordMap[task] || keywordMap.general;
  const hits = wanted.filter(keyword => strengths.some(strength => strength.includes(keyword) || keyword.includes(strength)));
  return { score: Math.min(1, hits.length / Math.max(1, wanted.length)), reason: entry.speciality, strengths: entry.strengths };
}

async function catalog() {
  if (!parentRouter || typeof parentRouter.listModels !== 'function') throw new Error('Shared OmniRoute router is unavailable.');
  try {
    const models = await parentRouter.listModels({ force: true });
    const raw = [...new Set((models || []).map(String).map(value => value.trim()).filter(Boolean))];
    const eligible = raw.filter(isAssistantEligibleModel);
    if (!eligible.length) throw new Error('OmniRoute catalog returned no non-Devin provider models.');
    const enriched = eligible.map(model => {
      const profile = knowledgeFor(model);
      const fit = suitability(model, 'general');
      return profile ? { model, provider: providerFromModel(model), ...profile, suitability: fit.score } : { model, provider: providerFromModel(model), suitability: fit.score };
    });
    const providerCounts = enriched.reduce((acc, item) => { acc[item.provider] = (acc[item.provider] || 0) + 1; return acc; }, {});
    return {
      models: eligible,
      enriched,
      count: eligible.length,
      rawCount: raw.length,
      devinExcludedCount: raw.filter(isDevinModel).length,
      providerCounts,
      knowledgeProfilesMatched: enriched.filter(item => item.speciality).length,
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
  const enriched = live.enriched.map(item => ({
    ...item,
    suitability: suitability(item.model, taskType || 'general').score,
    observed: observed.find(row => row.model === item.model) || null,
  }));
  return { live: { ...live, enriched }, observed, generatedAt: new Date().toISOString() };
}

module.exports = {
  record,
  history,
  summarize,
  catalog,
  intelligence,
  loadKnowledge,
  knowledgeFor,
  suitability,
  isRoutingAlias,
  isDevinModel,
  isBigPickle,
  isAssistantEligibleModel,
  providerFromModel,
};
