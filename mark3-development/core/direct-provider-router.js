const { load: loadCredentials } = require('../../core/credentials/local-store');

const DIRECT_TIMEOUT_MS = Math.max(4000, Number(process.env.ULTRON_M3_DIRECT_TIMEOUT_MS || 14000));
const DIRECT_HEAVY_TIMEOUT_MS = Math.max(DIRECT_TIMEOUT_MS, Number(process.env.ULTRON_M3_DIRECT_HEAVY_TIMEOUT_MS || 26000));
const FIRST_TOKEN_TIMEOUT_MS = Math.max(3000, Number(process.env.ULTRON_M3_DIRECT_FIRST_TOKEN_TIMEOUT_MS || 9000));
const KEY_RATE_LIMIT_COOLDOWN_MS = Math.max(15000, Number(process.env.ULTRON_M3_DIRECT_KEY_RATE_LIMIT_COOLDOWN_MS || 90000));
const KEY_ACCESS_COOLDOWN_MS = Math.max(KEY_RATE_LIMIT_COOLDOWN_MS, Number(process.env.ULTRON_M3_DIRECT_KEY_ACCESS_COOLDOWN_MS || 30 * 60 * 1000));
const MODEL_COOLDOWN_MS = Math.max(60000, Number(process.env.ULTRON_M3_DIRECT_MODEL_COOLDOWN_MS || 6 * 60 * 60 * 1000));
const MODEL_CACHE_MS = Math.max(30000, Number(process.env.ULTRON_M3_DIRECT_MODEL_CACHE_MS || 10 * 60 * 1000));
const MODEL_DISCOVERY_TIMEOUT_MS = Math.max(3000, Number(process.env.ULTRON_M3_DIRECT_MODEL_DISCOVERY_TIMEOUT_MS || 7000));
const MODELS_PER_PROVIDER = Math.max(1, Math.min(4, Number(process.env.ULTRON_M3_DIRECT_MODELS_PER_PROVIDER || 2)));

const PROVIDERS = {
  gemini: {
    family: 'gemini',
    keys: ['GEMINI_API_KEY', 'GEMINI_API_KEY2', 'GOOGLE_API_KEY', 'GOOGLE_API_KEY2'],
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    specialties: ['general conversation', 'research synthesis', 'long-context work', 'tool use'],
  },
  groq: {
    family: 'openai',
    keys: ['GROQ_API_KEY', 'GROQ_API_KEY2'],
    baseUrl: 'https://api.groq.com/openai/v1',
    specialties: ['low-latency answers', 'simple Q&A', 'automation', 'fast iteration'],
  },
  nvidia: {
    family: 'openai',
    keys: ['NVIDIA_API_KEY', 'NVIDIA_API_KEY2', 'NVIDIA_NIM_API_KEY'],
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    specialties: ['coding', 'planning', 'independent review', 'reasoning-heavy work'],
  },
};

const DEFAULT_MODELS = {
  gemini: {
    simple_qa: ['gemini-3.6-flash', 'gemini-3.5-flash-lite'],
    general: ['gemini-3.6-flash', 'gemini-3.5-flash'],
    coding: ['gemini-3.6-flash', 'gemini-3.5-flash'],
    planning: ['gemini-3.6-flash', 'gemini-3.5-flash'],
    research: ['gemini-3.6-flash', 'gemini-3.5-flash'],
    automation: ['gemini-3.6-flash', 'gemini-3.5-flash-lite'],
  },
  groq: {
    simple_qa: ['llama-3.1-8b-instant', 'qwen/qwen3.8-27b'],
    general: ['qwen/qwen3.8-27b', 'openai/gpt-oss-120b'],
    coding: ['qwen/qwen3.8-27b', 'openai/gpt-oss-120b'],
    planning: ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'],
    research: ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'],
    automation: ['llama-3.1-8b-instant', 'qwen/qwen3.8-27b'],
  },
  nvidia: {
    simple_qa: ['meta/llama-3.3-70b-instruct', 'openai/gpt-oss-120b'],
    general: ['openai/gpt-oss-120b', 'nvidia/nemotron-3-super-120b-a12b'],
    coding: ['deepseek-ai/deepseek-v4-flash', 'qwen/qwen2.5-coder-32b-instruct'],
    planning: ['nvidia/nemotron-3-super-120b-a12b', 'openai/gpt-oss-120b'],
    research: ['nvidia/nemotron-3-super-120b-a12b', 'openai/gpt-oss-120b'],
    automation: ['meta/llama-3.3-70b-instruct', 'openai/gpt-oss-120b'],
  },
};

const keyStates = new Map();
const modelCooldowns = new Map();
const catalogCache = new Map();
const discoveryStatus = new Map();

function csv(name) {
  return String(process.env[name] || '').split(',').map((value) => value.trim()).filter(Boolean);
}

function enabled() {
  return !/^(0|false|no|off)$/i.test(String(process.env.ULTRON_M3_DIRECT_ENABLED || '1'));
}

function taskName(taskType) {
  const value = String(taskType || 'general').toLowerCase();
  return ['simple_qa', 'general', 'coding', 'planning', 'research', 'automation'].includes(value) ? value : 'general';
}

function providerOrder(taskType) {
  const task = taskName(taskType);
  const configured = csv(`ULTRON_M3_DIRECT_PROVIDER_ORDER_${task.toUpperCase()}`).map((provider) => provider.toLowerCase());
  if (configured.length) return configured.filter((provider) => PROVIDERS[provider]);
  if (task === 'simple_qa' || task === 'automation') return ['groq', 'gemini', 'nvidia'];
  if (task === 'coding' || task === 'planning') return ['nvidia', 'gemini', 'groq'];
  if (task === 'research') return ['gemini', 'nvidia', 'groq'];
  return ['gemini', 'groq', 'nvidia'];
}

function configuredModelOverride(provider, taskType) {
  const task = taskName(taskType);
  const taskSpecific = csv(`ULTRON_M3_DIRECT_${provider.toUpperCase()}_${task.toUpperCase()}_MODELS`);
  const providerWide = csv(`ULTRON_M3_DIRECT_${provider.toUpperCase()}_MODELS`);
  return taskSpecific.length ? taskSpecific : providerWide;
}

function defaultModelList(provider, taskType) {
  const task = taskName(taskType);
  return DEFAULT_MODELS[provider]?.[task] || DEFAULT_MODELS[provider]?.general || [];
}

function canonical(provider, model) {
  let actual = String(model || '').replace(/^\/+/, '');
  if (provider === 'nvidia' && actual.toLowerCase().startsWith('nvidia/')) actual = actual.slice('nvidia/'.length);
  return `${provider}/${actual}`;
}

function parse(model) {
  const value = String(model || '').trim();
  const slash = value.indexOf('/');
  if (slash <= 0) {
    if (/^gemini[-_.]/i.test(value)) return { provider: 'gemini', model: value, canonical: canonical('gemini', value) };
    return { provider: null, model: value, canonical: value };
  }
  const provider = value.slice(0, slash).toLowerCase();
  if (!PROVIDERS[provider]) return { provider: null, model: value, canonical: value };
  let actual = value.slice(slash + 1);
  if (provider === 'nvidia' && /^(?:nemotron|llama-.*nemotron)/i.test(actual)) actual = `nvidia/${actual}`;
  return { provider, model: actual, canonical: value };
}

function providerForModel(model) { return parse(model).provider; }
function isDirectModel(model) { return Boolean(providerForModel(model)); }

function stateForKey(provider, slot) {
  const id = `${provider}:${slot}`;
  if (!keyStates.has(id)) {
    keyStates.set(id, {
      provider,
      slot,
      lastUsedAt: 0,
      lastSuccessAt: 0,
      lastFailureAt: 0,
      disabledUntil: 0,
      successes: 0,
      failures: 0,
      uses: 0,
      lastFailureKind: null,
    });
  }
  return keyStates.get(id);
}

function keyFailureKind(error) {
  const status = Number(error?.status || 0);
  const text = `${error?.message || ''} ${error?.raw || ''}`.toLowerCase();
  if (status === 429 || /quota|rate limit|too many requests|resource exhausted|exhausted/.test(text)) return 'RATE_LIMIT';
  if ([401, 403].includes(status) || /invalid.*key|api key.*invalid|authentication|unauthorized|forbidden|permission denied/.test(text)) return 'ACCESS';
  if ([404, 410].includes(status) || /model.*not.*found|model.*does not exist|not available/.test(text)) return 'MODEL_UNAVAILABLE';
  if (status === 400 && /model|unsupported|tool|request/.test(text)) return 'BAD_ROUTE';
  if ([408, 425, 500, 502, 503, 504].includes(status) || /timed out|abort|fetch failed|econnreset|econnrefused|upstream|gateway/.test(text)) return 'UPSTREAM';
  return 'UNKNOWN';
}

function keyCooldownFor(kind) {
  if (kind === 'RATE_LIMIT') return KEY_RATE_LIMIT_COOLDOWN_MS;
  if (kind === 'ACCESS') return KEY_ACCESS_COOLDOWN_MS;
  return 0;
}

function markKeyUsed(entry) {
  const state = stateForKey(entry.provider, entry.slot);
  state.lastUsedAt = Date.now();
  state.uses += 1;
}

function markKeySuccess(entry) {
  const state = stateForKey(entry.provider, entry.slot);
  state.lastSuccessAt = Date.now();
  state.successes += 1;
  state.lastFailureKind = null;
  state.disabledUntil = 0;
}

function markKeyFailure(entry, error) {
  const state = stateForKey(entry.provider, entry.slot);
  const kind = keyFailureKind(error);
  state.lastFailureAt = Date.now();
  state.failures += 1;
  state.lastFailureKind = kind;
  const cooldown = keyCooldownFor(kind);
  if (cooldown) state.disabledUntil = Math.max(state.disabledUntil || 0, Date.now() + cooldown);
  return kind;
}

function modelCooling(model) {
  const until = modelCooldowns.get(String(model));
  if (!until || until <= Date.now()) {
    modelCooldowns.delete(String(model));
    return false;
  }
  return true;
}

function markModelFailure(model, kind = 'UNKNOWN') {
  if (!['MODEL_UNAVAILABLE', 'BAD_ROUTE'].includes(kind)) return;
  const ttl = kind === 'MODEL_UNAVAILABLE' ? MODEL_COOLDOWN_MS : Math.min(MODEL_COOLDOWN_MS, 60 * 60 * 1000);
  modelCooldowns.set(String(model), Date.now() + ttl);
}
function markModelSuccess(model) { modelCooldowns.delete(String(model)); }

async function storedCredentials() {
  try { return await loadCredentials(); } catch { return {}; }
}

async function allCredentialEntries(provider) {
  const cfg = PROVIDERS[provider];
  if (!cfg) return [];
  const stored = await storedCredentials();
  const seenValues = new Set();
  const entries = [];
  for (const slot of cfg.keys) {
    const value = String(process.env[slot] || stored[slot] || '').trim();
    if (!value || seenValues.has(value)) continue;
    seenValues.add(value);
    entries.push({ provider, slot, value, state: stateForKey(provider, slot) });
  }
  return entries;
}

async function credentialPool(provider, { includeCooling = false } = {}) {
  const entries = await allCredentialEntries(provider);
  const filtered = entries.filter((entry) => includeCooling || Number(entry.state.disabledUntil || 0) <= Date.now());
  filtered.sort((a, b) => {
    const aUsed = Number(a.state.lastUsedAt || 0);
    const bUsed = Number(b.state.lastUsedAt || 0);
    if (aUsed !== bUsed) return aUsed - bUsed;
    const aRatio = a.state.uses ? a.state.failures / a.state.uses : 0;
    const bRatio = b.state.uses ? b.state.failures / b.state.uses : 0;
    return aRatio - bRatio || a.slot.localeCompare(b.slot);
  });
  return filtered.map((entry) => ({ ...entry, cooling: Number(entry.state.disabledUntil || 0) > Date.now() }));
}

async function credentialMap() {
  const out = {};
  for (const provider of Object.keys(PROVIDERS)) {
    const pool = await credentialPool(provider, { includeCooling: true });
    out[provider] = pool[0]?.value || '';
  }
  return out;
}

async function configuredProviders() {
  const out = [];
  for (const provider of Object.keys(PROVIDERS)) if ((await allCredentialEntries(provider)).length) out.push(provider);
  return out;
}

function nonChatModel(model) {
  return /(^|[\/_-])(embed|embedding|rerank|whisper|speech|audio|tts|transcrib|image|video|vision-embed)([\/_-]|$)/i.test(String(model || ''));
}

function sizeScore(value) {
  const match = String(value || '').toLowerCase().match(/(?:^|[-_/])(\d{1,3})b(?:[-_/]|$)/);
  return match ? Number(match[1]) : 0;
}

function modelScore(model, taskType, provider, preferenceIndex = -1) {
  const value = String(model || '').toLowerCase();
  const task = taskName(taskType);
  if (!value || nonChatModel(value)) return -10000;
  let score = preferenceIndex >= 0 ? 140 - preferenceIndex * 8 : 0;
  const size = sizeScore(value);
  if (/latest|stable/.test(value)) score += 8;
  if (/deprecated|legacy|retired|eol/.test(value)) score -= 100;
  if (/preview|experimental|exp\b/.test(value)) score -= 5;
  if (task === 'simple_qa' || task === 'automation') {
    if (/instant|flash|lite|mini|small|fast|8b/.test(value)) score += 35;
    if (size && size <= 12) score += 14;
    if (size >= 70) score -= 8;
  } else if (task === 'coding') {
    if (/coder|code|coding|deepseek|qwen|gpt-oss|nemotron/.test(value)) score += 38;
    if (/reason|think|pro/.test(value)) score += 10;
    if (size >= 27) score += 12;
  } else if (task === 'planning') {
    if (/reason|think|nemotron|gpt-oss|glm|pro|deepseek/.test(value)) score += 36;
    if (size >= 70) score += 15;
    else if (size >= 27) score += 8;
  } else if (task === 'research') {
    if (/pro|reason|think|nemotron|gpt-oss|glm|deepseek/.test(value)) score += 28;
    if (/flash/.test(value) && provider === 'gemini') score += 12;
    if (size >= 70) score += 10;
  } else {
    if (/flash|instruct|chat|qwen|gpt-oss|gemini/.test(value)) score += 20;
    if (/reason|pro|nemotron/.test(value)) score += 8;
    if (size >= 27 && size <= 120) score += 6;
  }
  const order = providerOrder(task);
  const providerRank = order.indexOf(provider);
  if (providerRank >= 0) score += Math.max(0, 30 - providerRank * 12);
  return score;
}

function parseCatalog(provider, data) {
  if (provider === 'gemini') {
    return (Array.isArray(data?.models) ? data.models : [])
      .filter((item) => !Array.isArray(item?.supportedGenerationMethods) || item.supportedGenerationMethods.includes('generateContent'))
      .map((item) => String(item?.name || '').replace(/^models\//, '').trim())
      .filter(Boolean);
  }
  return (Array.isArray(data?.data) ? data.data : [])
    .map((item) => typeof item === 'string' ? item : String(item?.id || item?.model || '').trim())
    .filter(Boolean);
}

function errorFor(provider, response, raw, slot = null) {
  const suffix = slot ? ` via ${slot}` : '';
  const error = new Error(`${provider} direct HTTP ${response.status}${suffix}: ${String(raw || '').slice(0, 1000)}`);
  error.status = response.status;
  error.raw = raw;
  error.directProvider = provider;
  error.credentialSlot = slot;
  return error;
}

async function fetchCatalogWithKey(provider, entry) {
  const cfg = PROVIDERS[provider];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_DISCOVERY_TIMEOUT_MS);
  try {
    const url = provider === 'gemini' ? `${cfg.baseUrl}/models?key=${encodeURIComponent(entry.value)}` : `${cfg.baseUrl}/models`;
    const response = await fetch(url, {
      headers: provider === 'gemini' ? {} : { Authorization: `Bearer ${entry.value}` },
      signal: controller.signal,
    });
    const raw = await response.text();
    if (!response.ok) throw errorFor(provider, response, raw, entry.slot);
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { throw new Error(`${provider} model catalog returned invalid JSON.`); }
    return [...new Set(parseCatalog(provider, data).filter((model) => !nonChatModel(model)))];
  } finally { clearTimeout(timer); }
}

async function discoverProviderModels(provider, { force = false } = {}) {
  const cached = catalogCache.get(provider);
  if (!force && cached?.models?.length && Date.now() - cached.fetchedAt < MODEL_CACHE_MS) return [...cached.models];

  // Discovery is deliberately passive: it never mutates inference key health,
  // usage counters or cooldowns. A /models timeout is not evidence that a key
  // cannot perform inference.
  const pool = await allCredentialEntries(provider);
  let lastError = null;
  for (const entry of pool) {
    try {
      const models = await fetchCatalogWithKey(provider, entry);
      if (models.length) {
        catalogCache.set(provider, { models, fetchedAt: Date.now(), slot: entry.slot });
        discoveryStatus.set(provider, { ok: true, at: Date.now(), slot: entry.slot, error: null });
        return [...models];
      }
    } catch (error) {
      lastError = error;
      discoveryStatus.set(provider, { ok: false, at: Date.now(), slot: entry.slot, error: String(error.message || error).slice(0, 300) });
    }
  }
  if (cached?.models?.length) return [...cached.models];
  if (lastError && /^(1|true|yes|on)$/i.test(String(process.env.ULTRON_M3_DIRECT_MODEL_DISCOVERY_STRICT || '0'))) throw lastError;
  return [];
}

async function modelList(provider, taskType) {
  const override = configuredModelOverride(provider, taskType);
  if (override.length) return [...new Set(override)].filter((model) => !nonChatModel(model)).slice(0, MODELS_PER_PROVIDER);
  const discovered = await discoverProviderModels(provider);
  const preferred = defaultModelList(provider, taskType);
  if (!discovered.length) return preferred.slice(0, MODELS_PER_PROVIDER);
  const preferenceMap = new Map(preferred.map((model, index) => [String(model).toLowerCase(), index]));
  return discovered
    .map((model) => ({ model, score: modelScore(model, taskType, provider, preferenceMap.has(model.toLowerCase()) ? preferenceMap.get(model.toLowerCase()) : -1) }))
    .filter((entry) => entry.score > -1000)
    .sort((a, b) => b.score - a.score || a.model.localeCompare(b.model))
    .slice(0, MODELS_PER_PROVIDER)
    .map((entry) => entry.model);
}

async function candidates(taskType = 'general') {
  if (!enabled()) return [];
  const rows = [];
  for (const provider of providerOrder(taskType)) {
    if (!(await allCredentialEntries(provider)).length) continue;
    const models = await modelList(provider, taskType);
    rows.push({ provider, models: models.map((model) => canonical(provider, model)).filter((model) => !modelCooling(model)) });
  }
  const out = [];
  const maxDepth = rows.reduce((max, row) => Math.max(max, row.models.length), 0);
  for (let depth = 0; depth < maxDepth; depth += 1) {
    for (const row of rows) if (row.models[depth]) out.push(row.models[depth]);
  }
  return [...new Set(out)];
}

async function allConfiguredModels() {
  const out = [];
  for (const task of ['simple_qa', 'general', 'coding', 'planning', 'research', 'automation']) out.push(...await candidates(task));
  return [...new Set(out)];
}

function timeoutFor(taskType) {
  return ['coding', 'planning', 'research'].includes(taskName(taskType)) ? DIRECT_HEAVY_TIMEOUT_MS : DIRECT_TIMEOUT_MS;
}

function normalizeMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((row) => ({
    ...row,
    role: row?.role === 'model' ? 'assistant' : String(row?.role || 'user'),
    content: row?.content == null ? null : typeof row.content === 'string' ? row.content : String(row.content),
  }));
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

function openAiTools(tools) { return Array.isArray(tools) && tools.length ? tools : undefined; }
function geminiTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  const declarations = tools.map((tool) => tool?.function || tool).filter((fn) => fn?.name).map((fn) => ({
    name: fn.name,
    description: fn.description || '',
    parameters: fn.parameters || { type: 'object', properties: {} },
  }));
  return declarations.length ? [{ functionDeclarations: declarations }] : undefined;
}

function geminiPayload(messages, tools) {
  const clean = normalizeMessages(messages);
  const system = clean.filter((row) => row.role === 'system').map((row) => row.content || '').filter(Boolean).join('\n\n');
  const contents = [];
  for (const row of clean.filter((item) => item.role !== 'system')) {
    if (row.role === 'assistant' && Array.isArray(row.tool_calls) && row.tool_calls.length) {
      const parts = [];
      if (row.content) parts.push({ text: row.content });
      for (const call of row.tool_calls) {
        const fn = call?.function || {};
        let args = {};
        try { args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments || '{}') : fn.arguments || {}; } catch {}
        if (fn.name) parts.push({ functionCall: { name: fn.name, args } });
      }
      contents.push({ role: 'model', parts });
      continue;
    }
    if (row.role === 'tool') {
      let response = row.content;
      try { response = JSON.parse(row.content || '{}'); } catch { response = { result: row.content || '' }; }
      contents.push({ role: 'user', parts: [{ functionResponse: { name: row.name || 'tool', response } }] });
      continue;
    }
    contents.push({ role: row.role === 'assistant' ? 'model' : 'user', parts: [{ text: row.content || '' }] });
  }
  const body = { contents };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const converted = geminiTools(tools);
  if (converted) body.tools = converted;
  return body;
}

function geminiResult(data, parsed, slot) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const content = parts.map((part) => part?.text || '').join('');
  const toolCalls = parts.filter((part) => part?.functionCall?.name).map((part, index) => ({
    id: `gemini-${Date.now()}-${index}`,
    type: 'function',
    function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) },
  }));
  if (!content.trim() && !toolCalls.length) throw new Error('Gemini direct API returned no visible text or tool calls.');
  return { content, toolCalls, model: parsed.canonical, provider: 'gemini', transport: 'direct', credentialSlot: slot, raw: data };
}

async function chatWithKey({ parsed, entry, messages, tools, budget }) {
  const cfg = PROVIDERS[parsed.provider];
  if (cfg.family === 'gemini') {
    const url = `${cfg.baseUrl}/models/${encodeURIComponent(parsed.model)}:generateContent?key=${encodeURIComponent(entry.value)}`;
    const response = await fetchWithTimeout(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(geminiPayload(messages, tools)) }, budget);
    const raw = await response.text();
    if (!response.ok) throw errorFor(parsed.provider, response, raw, entry.slot);
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { throw new Error('Gemini direct API returned invalid JSON.'); }
    return geminiResult(data, parsed, entry.slot);
  }

  const response = await fetchWithTimeout(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${entry.value}` },
    body: JSON.stringify({ model: parsed.model, messages: normalizeMessages(messages), ...(openAiTools(tools) ? { tools: openAiTools(tools) } : {}) }),
  }, budget);
  const raw = await response.text();
  if (!response.ok) throw errorFor(parsed.provider, response, raw, entry.slot);
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { throw new Error(`${parsed.provider} direct API returned invalid JSON.`); }
  const message = data?.choices?.[0]?.message || {};
  const content = typeof message.content === 'string' ? message.content : '';
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (!content.trim() && !toolCalls.length) throw new Error(`${parsed.provider} direct API returned no visible text or tool calls.`);
  return { content, toolCalls, model: parsed.canonical, provider: parsed.provider, transport: 'direct', credentialSlot: entry.slot, raw: data };
}

function poolUnavailableError(provider, configured) {
  const error = new Error(configured.length ? `All ${provider} API keys are cooling down from verified quota/auth failures.` : `Direct provider ${provider} is not configured.`);
  error.status = configured.length ? 429 : 401;
  return error;
}

async function chat({ messages, model, tools = null, taskType = 'general', timeoutMs = null } = {}) {
  const parsed = parse(model);
  if (!parsed.provider) throw new Error(`Not a direct provider model: ${model}`);
  const pool = await credentialPool(parsed.provider);
  if (!pool.length) throw poolUnavailableError(parsed.provider, await credentialPool(parsed.provider, { includeCooling: true }));

  const budget = Math.max(3000, Number(timeoutMs || timeoutFor(taskType)));
  let lastError = null;
  const attempts = [];
  for (const entry of pool) {
    markKeyUsed(entry);
    attempts.push(entry.slot);
    try {
      const result = await chatWithKey({ parsed, entry, messages, tools, budget });
      markKeySuccess(entry);
      markModelSuccess(parsed.canonical);
      return { ...result, keyAttempts: attempts.length };
    } catch (error) {
      lastError = error;
      error.credentialSlot ||= entry.slot;
      const kind = markKeyFailure(entry, error);
      if (kind === 'MODEL_UNAVAILABLE' || kind === 'BAD_ROUTE') {
        markModelFailure(parsed.canonical, kind);
        break;
      }
      // Provider/network failure is not evidence that the second account is bad.
      // Let Mark 3 move to the next provider instead of wasting another key.
      if (kind === 'UPSTREAM' || kind === 'UNKNOWN') break;
      // RATE_LIMIT / ACCESS are key-specific: try the next configured account.
    }
  }
  const error = lastError || new Error(`${parsed.provider} direct API exhausted its credential pool.`);
  error.keyAttempts = attempts;
  throw error;
}

async function readSse(response, onEvent) {
  if (!response.body) throw new Error('Streaming response has no body.');
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, boundary).replace(/\r/g, '');
      buffer = buffer.slice(boundary + 2);
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data) await onEvent(data);
      }
    }
  }
  const tail = buffer.trim();
  if (tail.startsWith('data:')) await onEvent(tail.slice(5).trim());
}

async function streamWithKey({ parsed, entry, messages, taskType, onDelta, firstTokenTimeoutMs }) {
  const cfg = PROVIDERS[parsed.provider];
  const controller = new AbortController();
  const firstBudget = Math.max(2500, Number(firstTokenTimeoutMs || FIRST_TOKEN_TIMEOUT_MS));
  const totalBudget = Math.max(firstBudget + 3000, timeoutFor(taskType) * 4);
  let firstSeen = false;
  let firstTimer;
  const totalTimer = setTimeout(() => controller.abort(), totalBudget);
  const armFirst = () => { firstTimer = setTimeout(() => { if (!firstSeen) controller.abort(); }, firstBudget); };
  const seen = () => { if (!firstSeen) { firstSeen = true; clearTimeout(firstTimer); } };
  armFirst();
  let fullText = '';
  try {
    if (cfg.family === 'gemini') {
      const url = `${cfg.baseUrl}/models/${encodeURIComponent(parsed.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(entry.value)}`;
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(geminiPayload(messages, null)), signal: controller.signal });
      if (!response.ok) { const raw = await response.text(); throw errorFor(parsed.provider, response, raw, entry.slot); }
      await readSse(response, async (raw) => {
        if (raw === '[DONE]') return;
        let data;
        try { data = JSON.parse(raw); } catch { return; }
        const text = (data?.candidates?.[0]?.content?.parts || []).map((part) => part?.text || '').join('');
        if (!text) return;
        seen();
        fullText += text;
        onDelta(text, { model: parsed.canonical, provider: parsed.provider, transport: 'direct', credentialSlot: entry.slot });
      });
    } else {
      const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${entry.value}` },
        body: JSON.stringify({ model: parsed.model, messages: normalizeMessages(messages), stream: true }),
        signal: controller.signal,
      });
      if (!response.ok) { const raw = await response.text(); throw errorFor(parsed.provider, response, raw, entry.slot); }
      await readSse(response, async (raw) => {
        if (raw === '[DONE]') return;
        let data;
        try { data = JSON.parse(raw); } catch { return; }
        const text = data?.choices?.[0]?.delta?.content || '';
        if (!text) return;
        seen();
        fullText += text;
        onDelta(text, { model: parsed.canonical, provider: parsed.provider, transport: 'direct', credentialSlot: entry.slot });
      });
    }
    if (!fullText.trim()) throw new Error(`${parsed.provider} direct stream returned no visible text.`);
    return { content: fullText, toolCalls: [], model: parsed.canonical, provider: parsed.provider, transport: 'direct', credentialSlot: entry.slot, raw: null, partialStream: firstSeen };
  } catch (error) {
    if (firstSeen) error.partialStream = true;
    throw error;
  } finally {
    clearTimeout(firstTimer);
    clearTimeout(totalTimer);
  }
}

async function streamChat({ messages, model, tools = null, taskType = 'general', onDelta, firstTokenTimeoutMs = null } = {}) {
  if (typeof onDelta !== 'function') throw new Error('Direct streaming requires onDelta.');
  if (Array.isArray(tools) && tools.length) {
    const data = await chat({ messages, model, tools, taskType, timeoutMs: timeoutFor(taskType) });
    if (data.content) onDelta(data.content, { model: data.model, provider: data.provider, transport: 'direct', credentialSlot: data.credentialSlot });
    return data;
  }

  const parsed = parse(model);
  if (!parsed.provider) throw new Error(`Not a direct provider model: ${model}`);
  const pool = await credentialPool(parsed.provider);
  if (!pool.length) throw poolUnavailableError(parsed.provider, await credentialPool(parsed.provider, { includeCooling: true }));

  let lastError = null;
  const attempts = [];
  for (const entry of pool) {
    markKeyUsed(entry);
    attempts.push(entry.slot);
    try {
      const result = await streamWithKey({ parsed, entry, messages, taskType, onDelta, firstTokenTimeoutMs });
      markKeySuccess(entry);
      markModelSuccess(parsed.canonical);
      return { ...result, keyAttempts: attempts.length };
    } catch (error) {
      lastError = error;
      if (error.partialStream) throw error;
      const kind = markKeyFailure(entry, error);
      if (kind === 'MODEL_UNAVAILABLE' || kind === 'BAD_ROUTE') {
        markModelFailure(parsed.canonical, kind);
        break;
      }
      if (kind === 'UPSTREAM' || kind === 'UNKNOWN') break;
    }
  }
  const error = lastError || new Error(`${parsed.provider} direct streaming exhausted its credential pool.`);
  error.keyAttempts = attempts;
  throw error;
}

function keySummary(provider, entries) {
  return entries.map((entry) => {
    const state = stateForKey(provider, entry.slot);
    const cooling = Number(state.disabledUntil || 0) > Date.now();
    return {
      slot: entry.slot,
      status: cooling ? 'cooldown' : state.lastSuccessAt ? 'healthy' : 'ready',
      uses: state.uses,
      successes: state.successes,
      failures: state.failures,
      lastFailureKind: state.lastFailureKind,
      disabledUntil: cooling ? new Date(state.disabledUntil).toISOString() : null,
    };
  });
}

async function health() {
  const providers = {};
  for (const provider of Object.keys(PROVIDERS)) {
    const entries = await credentialPool(provider, { includeCooling: true });
    let models = [];
    if (entries.length) {
      try { models = (await modelList(provider, 'general')).map((model) => canonical(provider, model)); } catch {}
    }
    providers[provider] = {
      configured: entries.length > 0,
      keyCount: entries.length,
      keys: keySummary(provider, entries),
      models,
      discovery: discoveryStatus.get(provider) || null,
      specialties: PROVIDERS[provider].specialties,
    };
  }
  return {
    enabled: enabled(),
    configured: Object.values(providers).some((row) => row.configured),
    strategy: 'specialist-provider-order + passive-catalog + quota-only-key-cooldown + least-recently-used-key-pool',
    providers,
    providerOrder: {
      general: providerOrder('general'),
      simple_qa: providerOrder('simple_qa'),
      coding: providerOrder('coding'),
      planning: providerOrder('planning'),
      research: providerOrder('research'),
      automation: providerOrder('automation'),
    },
  };
}

function clearCache() { catalogCache.clear(); discoveryStatus.clear(); }
function resetTransientHealth() {
  for (const state of keyStates.values()) {
    state.disabledUntil = 0;
    state.lastFailureKind = null;
  }
  modelCooldowns.clear();
}

module.exports = {
  PROVIDERS,
  DEFAULT_MODELS,
  enabled,
  parse,
  canonical,
  providerForModel,
  isDirectModel,
  credentialPool,
  credentialMap,
  configuredProviders,
  providerOrder,
  modelList,
  candidates,
  allConfiguredModels,
  discoverProviderModels,
  chat,
  streamChat,
  health,
  timeoutFor,
  clearCache,
  resetTransientHealth,
};
