const store = require('./mission-store');

const NVIDIA_BASE = String(process.env.ULTRON_M3_FORGE_NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '');
const TIMEOUT_MS = Math.max(15000, Number(process.env.ULTRON_M3_FORGE_MODEL_TIMEOUT_MS || 90000));
const MAX_CALLS = Math.max(10, Number(process.env.ULTRON_M3_FORGE_MAX_CALLS_PER_MISSION || 120));
const MAX_TOKENS = Math.max(50000, Number(process.env.ULTRON_M3_FORGE_MAX_TOKENS_PER_MISSION || 900000));

const ROLE_MODELS = {
  code_build: [
    'poolside/laguna-xs-2.1',
    'deepseek-ai/deepseek-v4-pro-0813',
    'z-ai/glm-5.2',
  ],
  code_review: [
    'z-ai/glm-5.2',
    'deepseek-ai/deepseek-v4-pro-0813',
    'poolside/laguna-xs-2.1',
  ],
  architecture: [
    'z-ai/glm-5.2',
    'poolside/laguna-xs-2.1',
    'deepseek-ai/deepseek-v4-pro-0813',
  ],
  mission_compile: [
    'poolside/laguna-xs-2.1',
    'z-ai/glm-5.2',
  ],
  automation: [
    'poolside/laguna-xs-2.1',
    'z-ai/glm-5.2',
  ],
};

let cursor = 0;
const cooldowns = new Map();

function csv(name) {
  return String(process.env[name] || '').split(',').map((value) => value.trim()).filter(Boolean);
}
function configuredModels(role) {
  const override = csv(`ULTRON_M3_FORGE_${String(role || '').toUpperCase()}_MODELS`);
  return override.length ? override : ROLE_MODELS[role] || ROLE_MODELS.code_build;
}
function keyRows() {
  const names = ['NVIDIA_API_KEY', 'NVIDIA_NIM_API_KEY'];
  for (let index = 2; index <= 8; index += 1) names.push(`NVIDIA_API_KEY${index}`);
  const seen = new Set();
  return names.map((slot) => ({ slot, value: String(process.env[slot] || '').trim() }))
    .filter((row) => row.value && !seen.has(row.value) && seen.add(row.value));
}
function keyAvailable(row) {
  const until = cooldowns.get(row.slot) || 0;
  if (until <= Date.now()) { cooldowns.delete(row.slot); return true; }
  return false;
}
function orderedKeys() {
  const rows = keyRows();
  if (!rows.length) return [];
  const start = cursor % rows.length;
  return [...rows.slice(start), ...rows.slice(0, start)].filter(keyAvailable);
}
function cooldown(row, error) {
  const status = Number(error?.status || 0);
  const text = String(error?.message || '').toLowerCase();
  if (status === 429 || /rate.?limit|quota|exhaust/.test(text)) cooldowns.set(row.slot, Date.now() + 90_000);
  else if ([401, 403].includes(status)) cooldowns.set(row.slot, Date.now() + 30 * 60_000);
  else if (status >= 500 || /timeout|timed out|upstream/.test(text)) cooldowns.set(row.slot, Date.now() + 30_000);
}
function parseText(data) {
  const value = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map((item) => typeof item === 'string' ? item : item?.text || '').join('').trim();
  return String(value || '').trim();
}
function usageFrom(data, inputText, outputText) {
  const actual = data?.usage || {};
  const inputTokens = Number(actual.prompt_tokens || actual.input_tokens || Math.ceil(String(inputText || '').length / 4));
  const outputTokens = Number(actual.completion_tokens || actual.output_tokens || Math.ceil(String(outputText || '').length / 4));
  const totalTokens = Number(actual.total_tokens || inputTokens + outputTokens);
  return { inputTokens, outputTokens, totalTokens };
}
function assertBudget(missionId) {
  if (!missionId) return;
  const current = store.usage(missionId);
  if (current.calls >= MAX_CALLS) throw new Error(`FORGE_BUDGET: mission reached ${MAX_CALLS} model calls.`);
  if (current.totalTokens >= MAX_TOKENS) throw new Error(`FORGE_BUDGET: mission reached ${MAX_TOKENS} tokens.`);
}
function recordUsage(missionId, model, slot, delta) {
  if (!missionId) return;
  const current = store.usage(missionId);
  const next = {
    ...current,
    calls: Number(current.calls || 0) + 1,
    inputTokens: Number(current.inputTokens || 0) + delta.inputTokens,
    outputTokens: Number(current.outputTokens || 0) + delta.outputTokens,
    totalTokens: Number(current.totalTokens || 0) + delta.totalTokens,
    byModel: { ...(current.byModel || {}) },
    byKeySlot: { ...(current.byKeySlot || {}) },
  };
  next.byModel[model] = {
    calls: Number(next.byModel[model]?.calls || 0) + 1,
    tokens: Number(next.byModel[model]?.tokens || 0) + delta.totalTokens,
  };
  next.byKeySlot[slot] = Number(next.byKeySlot[slot] || 0) + 1;
  store.saveUsage(missionId, next);
}
async function nvidiaChat({ missionId, role = 'code_build', messages, temperature = 0.2, maxTokens = 8192, json = false }) {
  assertBudget(missionId);
  const keys = orderedKeys();
  if (!keys.length) throw new Error('FORGE_NO_NVIDIA_KEY: configure NVIDIA_API_KEY (or another supported NVIDIA key slot).');
  const models = configuredModels(role);
  const failures = [];
  const inputText = JSON.stringify(messages || []);

  for (const model of models) {
    for (const row of keys) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const body = {
          model,
          messages,
          temperature,
          max_tokens: maxTokens,
          stream: false,
        };
        if (json) body.response_format = { type: 'json_object' };
        const response = await fetch(`${NVIDIA_BASE}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${row.value}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const raw = await response.text();
        let data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
        if (!response.ok) {
          const error = new Error(`NVIDIA ${model} HTTP ${response.status}: ${raw.slice(0, 600)}`);
          error.status = response.status;
          throw error;
        }
        const text = parseText(data);
        if (!text) throw new Error(`NVIDIA ${model} returned no text.`);
        const delta = usageFrom(data, inputText, text);
        recordUsage(missionId, model, row.slot, delta);
        cursor = (keyRows().findIndex((entry) => entry.slot === row.slot) + 1) % Math.max(1, keyRows().length);
        return { ok: true, provider: 'nvidia', model, keySlot: row.slot, text, usage: delta, raw: data };
      } catch (error) {
        cooldown(row, error);
        failures.push(`${model}/${row.slot}: ${error.message}`);
      } finally {
        clearTimeout(timer);
      }
    }
  }
  throw new Error(`FORGE_NVIDIA_UNAVAILABLE: ${failures.slice(-6).join(' | ')}`);
}
function status() {
  return {
    zeroCostOnly: true,
    localLlmAllowed: false,
    paidFallbackAllowed: false,
    provider: 'nvidia',
    endpoint: NVIDIA_BASE,
    configuredKeySlots: keyRows().map((row) => row.slot),
    roleModels: ROLE_MODELS,
    maxCallsPerMission: MAX_CALLS,
    maxTokensPerMission: MAX_TOKENS,
  };
}

module.exports = { ROLE_MODELS, configuredModels, keyRows, nvidiaChat, status, assertBudget };
