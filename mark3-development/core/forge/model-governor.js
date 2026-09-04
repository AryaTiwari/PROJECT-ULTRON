const store = require('./mission-store');
const { redactMessages } = require('./redactor');

const NVIDIA_BASE = String(process.env.ULTRON_M3_FORGE_NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '');
const TIMEOUT_MS = Math.max(15000, Number(process.env.ULTRON_M3_FORGE_MODEL_TIMEOUT_MS || 90000));
const POLL_INTERVAL_MS = Math.max(250, Number(process.env.ULTRON_M3_FORGE_NVIDIA_POLL_INTERVAL_MS || 1000));
const MAX_CALLS = Math.max(10, Number(process.env.ULTRON_M3_FORGE_MAX_CALLS_PER_MISSION || 120));
const MAX_TOKENS = Math.max(50000, Number(process.env.ULTRON_M3_FORGE_MAX_TOKENS_PER_MISSION || 900000));

// Keep the pool limited to currently useful zero-cost coding/agentic endpoints.
// MiniMax M3 is a temporary emergency route only because NVIDIA currently marks it for deprecation.
const ROLE_MODELS = {
  code_build: ['poolside/laguna-xs-2.1', 'deepseek-ai/deepseek-v4-pro-0813', 'minimaxai/minimax-m3'],
  code_review: ['deepseek-ai/deepseek-v4-pro-0813', 'poolside/laguna-xs-2.1', 'minimaxai/minimax-m3'],
  architecture: ['poolside/laguna-xs-2.1', 'deepseek-ai/deepseek-v4-pro-0813', 'minimaxai/minimax-m3'],
  mission_compile: ['poolside/laguna-xs-2.1', 'deepseek-ai/deepseek-v4-pro-0813'],
  automation: ['poolside/laguna-xs-2.1', 'deepseek-ai/deepseek-v4-pro-0813', 'minimaxai/minimax-m3'],
};

let cursor = 0;
const keyCooldowns = new Map();
const modelCooldowns = new Map();
const disabledModels = new Map();

function csv(name) { return String(process.env[name] || '').split(',').map((value) => value.trim()).filter(Boolean); }
function configuredModels(role) {
  const override = csv(`ULTRON_M3_FORGE_${String(role || '').toUpperCase()}_MODELS`);
  const source = override.length ? override : ROLE_MODELS[role] || ROLE_MODELS.code_build;
  return source.filter((model) => !disabledModels.has(model) && Number(modelCooldowns.get(model) || 0) <= Date.now());
}
function keyRows() {
  const names = ['NVIDIA_API_KEY', 'NVIDIA_NIM_API_KEY'];
  for (let index = 2; index <= 8; index += 1) names.push(`NVIDIA_API_KEY${index}`);
  const seen = new Set();
  return names.map((slot) => ({ slot, value: String(process.env[slot] || '').trim() }))
    .filter((row) => row.value && !seen.has(row.value) && seen.add(row.value));
}
function keyAvailable(row) {
  const until = keyCooldowns.get(row.slot) || 0;
  if (until <= Date.now()) { keyCooldowns.delete(row.slot); return true; }
  return false;
}
function orderedKeys() {
  const rows = keyRows();
  if (!rows.length) return [];
  const start = cursor % rows.length;
  return [...rows.slice(start), ...rows.slice(0, start)].filter(keyAvailable);
}
function classifyFailure(model, row, error) {
  const status = Number(error?.status || 0);
  const text = String(error?.message || '').toLowerCase();
  if (status === 404 || status === 410 || /end of life|deprecated|no longer available|model .* gone/.test(text)) {
    disabledModels.set(model, { reason: error.message, at: new Date().toISOString() });
    return 'model-disabled';
  }
  if ([401, 403].includes(status)) {
    keyCooldowns.set(row.slot, Date.now() + 30 * 60_000);
    return 'key-auth';
  }
  if (status === 429 || /account quota|api quota|rate.?limit.*key|quota exceeded/.test(text)) {
    keyCooldowns.set(row.slot, Date.now() + 90_000);
    return 'key-quota';
  }
  if (status >= 500 || status === 408 || /resourceexhausted|worker .*limit|timeout|timed out|upstream|aborted|service unavailable/.test(text)) {
    modelCooldowns.set(model, Date.now() + (status === 503 || /resourceexhausted|worker .*limit/.test(text) ? 120_000 : 60_000));
    return 'model-transient';
  }
  return 'unknown';
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
function applyUsage(missionId, model, slot, delta, calls = 1) {
  if (!missionId) return;
  const current = store.usage(missionId);
  const addCalls = Math.max(0, Number(calls || 0));
  const inputTokens = Math.max(0, Number(delta?.inputTokens || 0));
  const outputTokens = Math.max(0, Number(delta?.outputTokens || 0));
  const totalTokens = Math.max(0, Number(delta?.totalTokens || inputTokens + outputTokens));
  if (Number(current.calls || 0) + addCalls > MAX_CALLS) throw new Error(`FORGE_BUDGET: projected usage exceeds ${MAX_CALLS} model calls.`);
  if (Number(current.totalTokens || 0) + totalTokens > MAX_TOKENS) throw new Error(`FORGE_BUDGET: projected usage exceeds ${MAX_TOKENS} tokens.`);
  const next = {
    ...current,
    calls: Number(current.calls || 0) + addCalls,
    inputTokens: Number(current.inputTokens || 0) + inputTokens,
    outputTokens: Number(current.outputTokens || 0) + outputTokens,
    totalTokens: Number(current.totalTokens || 0) + totalTokens,
    byModel: { ...(current.byModel || {}) }, byKeySlot: { ...(current.byKeySlot || {}) },
  };
  next.byModel[model] = {
    calls: Number(next.byModel[model]?.calls || 0) + addCalls,
    tokens: Number(next.byModel[model]?.tokens || 0) + totalTokens,
  };
  next.byKeySlot[slot] = Number(next.byKeySlot[slot] || 0) + addCalls;
  store.saveUsage(missionId, next);
}
function recordUsage(missionId, model, slot, delta) { applyUsage(missionId, model, slot, delta, 1); }
function reserveExternalUsage(missionId, model, slot, estimate = {}) {
  const calls = Math.max(1, Number(estimate.calls || 1));
  applyUsage(missionId, model, slot, estimate, calls);
  if (missionId) store.event(missionId, 'external_inference_budget_reserved', { model, slot, calls, totalTokens: Number(estimate.totalTokens || 0) });
  return { calls, totalTokens: Number(estimate.totalTokens || 0) };
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function requestIdFrom(response, data = {}) {
  return String(
    response?.headers?.get?.('nvcf-reqid')
    || response?.headers?.get?.('x-request-id')
    || data?.requestId
    || data?.request_id
    || data?.id
    || ''
  ).trim();
}
async function fetchWithDeadline(url, options, deadline, label) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    const error = new Error(`${label} timed out after ${TIMEOUT_MS}ms.`);
    error.status = 408;
    throw error;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (cause) {
    if (cause?.name === 'AbortError') {
      const error = new Error(`${label} timed out after ${TIMEOUT_MS}ms.`);
      error.status = 408;
      error.cause = cause;
      throw error;
    }
    throw cause;
  } finally {
    clearTimeout(timer);
  }
}
async function responseData(response) {
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  return { raw, data };
}
async function pollPending(requestId, row, model, deadline) {
  if (!requestId) {
    const error = new Error(`NVIDIA ${model} returned HTTP 202 without a request id.`);
    error.status = 502;
    throw error;
  }
  while (Date.now() < deadline) {
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
    const response = await fetchWithDeadline(
      `${NVIDIA_BASE}/status/${encodeURIComponent(requestId)}`,
      { method: 'GET', headers: { Authorization: `Bearer ${row.value}`, Accept: 'application/json' } },
      deadline,
      `NVIDIA ${model} async status polling`,
    );
    const { raw, data } = await responseData(response);
    if (response.status === 202) continue;
    if (!response.ok) {
      const error = new Error(`NVIDIA ${model} status HTTP ${response.status}: ${raw.slice(0, 600)}`);
      error.status = response.status;
      throw error;
    }
    return data;
  }
  const error = new Error(`NVIDIA ${model} async request ${requestId} timed out after ${TIMEOUT_MS}ms.`);
  error.status = 408;
  throw error;
}
async function requestModel(model, row, safeMessages, options) {
  const deadline = Date.now() + TIMEOUT_MS;
  const body = {
    model, messages: safeMessages, temperature: options.temperature,
    max_tokens: options.maxTokens, stream: false,
  };
  if (options.json) body.response_format = { type: 'json_object' };

  const response = await fetchWithDeadline(
    `${NVIDIA_BASE}/chat/completions`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${row.value}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    },
    deadline,
    `NVIDIA ${model} initial inference`,
  );
  const { raw, data } = await responseData(response);
  if (response.status === 202) return pollPending(requestIdFrom(response, data), row, model, deadline);
  if (!response.ok) {
    const error = new Error(`NVIDIA ${model} HTTP ${response.status}: ${raw.slice(0, 600)}`);
    error.status = response.status;
    throw error;
  }
  return data;
}
async function nvidiaChat({ missionId, role = 'code_build', messages, temperature = 0.2, maxTokens = 8192, json = false }) {
  assertBudget(missionId);
  const keys = orderedKeys();
  if (!keys.length) throw new Error('FORGE_NO_NVIDIA_KEY: configure NVIDIA_API_KEY (or another supported NVIDIA key slot).');
  const models = configuredModels(role);
  if (!models.length) throw new Error(`FORGE_NVIDIA_UNAVAILABLE: all configured ${role} models are temporarily unavailable or disabled.`);
  const failures = [];
  const safeMessages = redactMessages(messages || []);
  const inputText = JSON.stringify(safeMessages);

  for (const model of models) {
    for (const row of keys) {
      try {
        let data;
        try {
          data = await requestModel(model, row, safeMessages, { temperature, maxTokens, json });
        } catch (firstError) {
          if (json && Number(firstError?.status || 0) === 400) data = await requestModel(model, row, safeMessages, { temperature, maxTokens, json: false });
          else throw firstError;
        }
        const text = parseText(data);
        if (!text) throw new Error(`NVIDIA ${model} returned no text.`);
        const delta = usageFrom(data, inputText, text);
        recordUsage(missionId, model, row.slot, delta);
        cursor = (keyRows().findIndex((entry) => entry.slot === row.slot) + 1) % Math.max(1, keyRows().length);
        return { ok: true, provider: 'nvidia', model, keySlot: row.slot, text, usage: delta, raw: data };
      } catch (error) {
        const classification = classifyFailure(model, row, error);
        failures.push(`${model}/${row.slot} [${classification}]: ${error.message}`);
        if (classification === 'model-disabled' || classification === 'model-transient') break;
      }
    }
  }
  throw new Error(`FORGE_NVIDIA_UNAVAILABLE: ${failures.slice(-6).join(' | ')}`);
}
function status() {
  const now = Date.now();
  return {
    zeroCostOnly: true, localLlmAllowed: false, paidFallbackAllowed: false,
    provider: 'nvidia', endpoint: NVIDIA_BASE,
    configuredKeySlots: keyRows().map((row) => row.slot), roleModels: ROLE_MODELS,
    activeModelCooldowns: Object.fromEntries([...modelCooldowns.entries()].filter(([, until]) => until > now).map(([model, until]) => [model, new Date(until).toISOString()])),
    disabledModels: Object.fromEntries(disabledModels.entries()),
    maxCallsPerMission: MAX_CALLS, maxTokensPerMission: MAX_TOKENS,
    secretRedaction: true, externalWorkerBudgeting: true,
    asyncPolling: true, pollIntervalMs: POLL_INTERVAL_MS, timeoutMs: TIMEOUT_MS,
  };
}

module.exports = {
  ROLE_MODELS, configuredModels, keyRows, nvidiaChat, status, assertBudget, reserveExternalUsage,
  requestIdFrom, pollPending, classifyFailure,
};
