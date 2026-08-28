const { config } = require('./config');
const { load: loadCredentials } = require('./credentials/local-store');

const DEFAULT_TASK_ALIASES = {
  coding: 'auto/best-coding',
  research: 'auto/best-reasoning',
  planning: 'auto/best-reasoning',
  automation: 'auto/best-fast',
  creative: 'auto/best-fast',
  simple_qa: 'auto/best-fast',
  general: 'auto/best-fast',
};

let catalogCache = { models: [], fetchedAt: 0 };

function baseUrl() {
  return String(config.router.baseUrl || 'http://127.0.0.1:20128/v1').replace(/\/$/, '');
}

async function apiKey() {
  if (config.router.apiKey) return config.router.apiKey;
  try {
    const saved = await loadCredentials();
    return String(saved.OMNIROUTE_API_KEY || saved.ULTRON_OMNIROUTE_API_KEY || '').trim();
  } catch {
    return '';
  }
}

function headers(key, includeJson = false) {
  const out = includeJson ? { 'Content-Type': 'application/json' } : {};
  if (key) out.Authorization = `Bearer ${key}`;
  return out;
}

async function request(pathname, options = {}) {
  const key = await apiKey();
  const controller = new AbortController();
  const timeoutMs = Number(options.timeoutMs || config.router.timeoutMs || 120000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${baseUrl()}${pathname}`, {
      method: options.method || 'GET',
      headers: { ...headers(key, options.body != null), ...(options.headers || {}) },
      body: options.body,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`OmniRoute request timed out after ${timeoutMs}ms.`);
    throw new Error(`OmniRoute connection failed: ${error?.message || String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function parseResponse(response) {
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  if (!response.ok) {
    const error = new Error(`OmniRoute HTTP ${response.status}: ${raw.slice(0, 1200)}`);
    error.status = response.status;
    error.raw = raw;
    throw error;
  }
  return data;
}

function normalizeModelId(value) {
  const model = String(value || '').trim();
  return model.toLowerCase().startsWith('omniroute/') ? model.slice('omniroute/'.length) : model;
}

function modelIds(payload) {
  const raw = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  return raw.map(item => {
    if (typeof item === 'string') return item;
    return item?.id || item?.model || item?.name || '';
  }).map(String).map(s => s.trim()).filter(Boolean);
}

async function listModels({ force = false } = {}) {
  const ttlMs = Number(process.env.OMNIROUTE_MODEL_CACHE_MS || 300000);
  if (!force && catalogCache.models.length && Date.now() - catalogCache.fetchedAt < ttlMs) return [...catalogCache.models];
  const response = await request('/models', { timeoutMs: 10000 });
  const data = await parseResponse(response);
  const models = [...new Set(modelIds(data))];
  catalogCache = { models, fetchedAt: Date.now() };
  return [...models];
}

async function isConfigured() {
  return Boolean(await apiKey());
}

async function hasModel(model) {
  const target = normalizeModelId(model);
  if (!target) return false;
  try {
    const models = await listModels();
    return models.includes(target);
  } catch {
    return false;
  }
}

function candidateAliases(taskType) {
  const overrideKey = `ULTRON_OMNIROUTE_MODEL_${String(taskType || 'general').toUpperCase()}`;
  const override = String(process.env[overrideKey] || '').trim();
  const mapped = DEFAULT_TASK_ALIASES[String(taskType || 'general')] || DEFAULT_TASK_ALIASES.general;
  const general = String(process.env.ULTRON_OMNIROUTE_DEFAULT_MODEL || '').trim();
  return [override, mapped, general, 'auto', 'auto/best-fast', 'auto/best-reasoning'].filter(Boolean);
}

async function resolveModel(requestedModel = 'auto', taskType = 'general') {
  const requested = normalizeModelId(requestedModel);
  if (requested && requested !== 'auto') return requested;
  let models = [];
  try { models = await listModels(); } catch {}
  const candidates = candidateAliases(taskType);
  for (const candidate of candidates) if (!models.length || models.includes(candidate)) return candidate;
  return 'auto';
}

function transientStatus(status) {
  return [408, 425, 429, 500, 502, 503, 504].includes(Number(status));
}

async function chat({ messages, model = 'auto', taskType = 'general', tools = null } = {}) {
  if (!Array.isArray(messages) || !messages.length) throw new Error('OmniRoute request requires messages.');
  const resolvedModel = await resolveModel(model, taskType);
  const modelCandidates = [resolvedModel];
  if (resolvedModel !== 'auto' && taskType) modelCandidates.push('auto');
  if (!modelCandidates.includes('auto/best-fast')) modelCandidates.push('auto/best-fast');

  let lastError = null;
  for (const candidate of [...new Set(modelCandidates)]) {
    const body = { model: candidate, messages };
    if (Array.isArray(tools) && tools.length) body.tools = tools;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await request('/chat/completions', { method: 'POST', body: JSON.stringify(body) });
        const data = await parseResponse(response);
        const message = data?.choices?.[0]?.message || {};
        const content = message.content ?? data?.choices?.[0]?.text ?? data?.output_text ?? '';
        const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        if (!String(content).trim() && !toolCalls.length) throw new Error('OmniRoute returned no response text or tool calls.');
        return { content: String(content || ''), toolCalls, model: data?.model || candidate, provider: 'omniroute', raw: data, requestedModel: model, taskType };
      } catch (error) {
        lastError = error;
        if (!transientStatus(error?.status)) throw error;
        if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 350));
      }
    }
  }
  throw lastError || new Error('OmniRoute inference failed.');
}

async function health() {
  const started = Date.now();
  try {
    const response = await request('/models', { timeoutMs: 10000 });
    const data = await parseResponse(response);
    const models = modelIds(data);
    return {
      ok: true,
      authenticated: Boolean(await apiKey()),
      endpoint: baseUrl(),
      modelCount: models.length,
      catalogSample: models.slice(0, 12),
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return {
      ok: false,
      authenticated: Boolean(await apiKey()),
      endpoint: baseUrl(),
      modelCount: catalogCache.models.length,
      latencyMs: Date.now() - started,
      error: error.message,
    };
  }
}

function clearCache() { catalogCache = { models: [], fetchedAt: 0 }; }

module.exports = { listModels, hasModel, resolveModel, chat, health, isConfigured, normalizeModelId, clearCache };
