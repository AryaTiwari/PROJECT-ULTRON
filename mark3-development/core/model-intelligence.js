const fs = require('fs');
const path = require('path');
const config = require('./config');
const router = require('./model-router');
const { appendJsonl, readJsonl } = require('./persistence');

const KNOWLEDGE_PATH = path.join(config.root, 'core', 'model-knowledge.json');

function loadKnowledge() {
  try {
    const data = JSON.parse(fs.readFileSync(KNOWLEDGE_PATH, 'utf8'));
    return Array.isArray(data.models) ? data.models : [];
  } catch { return []; }
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
  const rows = history().filter((row) => !taskType || row.taskType === taskType);
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
  return [...groups.values()].map((group) => ({
    provider: group.provider,
    model: group.model,
    attempts: group.attempts,
    successRate: group.attempts ? group.successes / group.attempts : 0,
    averageLatencyMs: group.latency.length ? group.latency.reduce((a, b) => a + b, 0) / group.latency.length : null,
    averageQuality: group.quality.length ? group.quality.reduce((a, b) => a + b, 0) / group.quality.length : null,
  }));
}

function isDevinModel(id) { return router.isDevinModel(id); }
function isRoutingAlias(id) { return router.isRoutingAlias(id); }
function isBigPickle(id) { return /big[-_ ]?pickle/i.test(String(id || '')); }
function isAssistantEligibleModel(id) { return Boolean(String(id || '').trim() && !router.isBlockedModel(id)); }
function providerFromModel(modelId) { return router.providerFromModel(modelId); }

function knowledgeFor(modelId) {
  const value = String(modelId || '').trim().toLowerCase();
  if (!value) return null;
  return KNOWLEDGE.find((entry) => Array.isArray(entry.patterns) && entry.patterns.some((pattern) => value === String(pattern).toLowerCase() || value.includes(String(pattern).toLowerCase()))) || null;
}

function suitability(modelId, taskType = 'general') {
  const entry = knowledgeFor(modelId);
  if (!entry) return { score: 0, reason: 'No curated profile; rely on live performance history.' };
  const task = String(taskType || 'general').toLowerCase();
  const strengths = (entry.strengths || []).map(String).map((v) => v.toLowerCase());
  const keywordMap = {
    coding: ['coding', 'tool use', 'agents'],
    debugging: ['coding', 'reasoning', 'tool use', 'agents'],
    research: ['reasoning', 'long context', 'general chat'],
    multimodal: ['multimodal', 'vision', 'video', 'image'],
    planning: ['planning', 'reasoning', 'agents', 'tool calling'],
    general: ['general assistant', 'general intelligence', 'reasoning', 'chat'],
  };
  const wanted = keywordMap[task] || keywordMap.general;
  const hits = wanted.filter((keyword) => strengths.some((strength) => strength.includes(keyword) || keyword.includes(strength)));
  return { score: Math.min(1, hits.length / Math.max(1, wanted.length)), reason: entry.speciality, strengths: entry.strengths };
}

async function catalog() {
  try {
    const raw = await router.listUsableModels({ force: true });
    const eligible = [...new Set((raw || []).map(String).map((v) => v.trim()).filter(isAssistantEligibleModel))];
    if (!eligible.length) throw new Error('OmniRoute catalog returned no Mark 3-eligible models.');
    const enriched = eligible.map((model) => {
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
      devinExcludedCount: 0,
      providerCounts,
      knowledgeProfilesMatched: enriched.filter((item) => item.speciality).length,
      source: 'mark3-omniroute-live-catalog',
    };
  } catch (error) {
    throw new Error(`OmniRoute model catalog unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function intelligence(taskType = null) {
  const live = await catalog();
  const observed = summarize(taskType);
  const enriched = live.enriched.map((item) => ({
    ...item,
    suitability: suitability(item.model, taskType || 'general').score,
    observed: observed.find((row) => row.model === item.model) || null,
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
