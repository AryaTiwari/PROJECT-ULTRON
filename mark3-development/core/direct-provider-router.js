const { load: loadCredentials } = require('../../core/credentials/local-store');

const DIRECT_TIMEOUT_MS = Math.max(4000, Number(process.env.ULTRON_M3_DIRECT_TIMEOUT_MS || 14000));
const DIRECT_HEAVY_TIMEOUT_MS = Math.max(DIRECT_TIMEOUT_MS, Number(process.env.ULTRON_M3_DIRECT_HEAVY_TIMEOUT_MS || 26000));
const FIRST_TOKEN_TIMEOUT_MS = Math.max(3000, Number(process.env.ULTRON_M3_DIRECT_FIRST_TOKEN_TIMEOUT_MS || 9000));
const COOLDOWN_MS = Math.max(15000, Number(process.env.ULTRON_M3_DIRECT_COOLDOWN_MS || 90000));

const PROVIDERS = {
  gemini: {
    family: 'gemini',
    keys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  },
  groq: {
    family: 'openai',
    keys: ['GROQ_API_KEY'],
    baseUrl: 'https://api.groq.com/openai/v1',
  },
  nvidia: {
    family: 'openai',
    keys: ['NVIDIA_API_KEY', 'NVIDIA_NIM_API_KEY'],
    baseUrl: 'https://integrate.api.nvidia.com/v1',
  },
};

const DEFAULT_MODELS = {
  gemini: {
    simple_qa: ['gemini-3.5-flash-lite', 'gemini-3.6-flash'],
    general: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash'],
    coding: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash'],
    planning: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash'],
    research: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash'],
    automation: ['gemini-3.6-flash', 'gemini-3.5-flash-lite'],
  },
  groq: {
    simple_qa: ['llama-3.1-8b-instant', 'qwen/qwen3.8-27b'],
    general: ['qwen/qwen3.8-27b', 'openai/gpt-oss-120b', 'qwen/qwen3.6-27b'],
    coding: ['qwen/qwen3.8-27b', 'openai/gpt-oss-120b', 'qwen/qwen3.6-27b'],
    planning: ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'],
    research: ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'],
    automation: ['llama-3.1-8b-instant', 'qwen/qwen3.6-27b'],
  },
  nvidia: {
    simple_qa: ['meta/llama-3.3-70b-instruct', 'openai/gpt-oss-120b'],
    general: ['openai/gpt-oss-120b', 'nvidia/nemotron-3-super-120b-a12b', 'z-ai/glm-5.2'],
    coding: ['deepseek-ai/deepseek-v4-flash', 'openai/gpt-oss-120b', 'qwen/qwen2.5-coder-32b-instruct'],
    planning: ['nvidia/nemotron-3-super-120b-a12b', 'openai/gpt-oss-120b', 'z-ai/glm-5.2'],
    research: ['nvidia/nemotron-3-super-120b-a12b', 'openai/gpt-oss-120b', 'z-ai/glm-5.2'],
    automation: ['deepseek-ai/deepseek-v4-flash', 'meta/llama-3.3-70b-instruct'],
  },
};

const cooldowns = new Map();

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
  const configured = csv(`ULTRON_M3_DIRECT_PROVIDER_ORDER_${task.toUpperCase()}`);
  if (configured.length) return configured.filter((provider) => PROVIDERS[provider]);
  if (task === 'simple_qa' || task === 'automation') return ['groq', 'gemini', 'nvidia'];
  if (task === 'planning' || task === 'research') return ['gemini', 'nvidia', 'groq'];
  return ['gemini', 'groq', 'nvidia'];
}

function modelList(provider, taskType) {
  const task = taskName(taskType);
  const taskSpecific = csv(`ULTRON_M3_DIRECT_${provider.toUpperCase()}_${task.toUpperCase()}_MODELS`);
  const providerWide = csv(`ULTRON_M3_DIRECT_${provider.toUpperCase()}_MODELS`);
  return taskSpecific.length ? taskSpecific : providerWide.length ? providerWide : (DEFAULT_MODELS[provider]?.[task] || DEFAULT_MODELS[provider]?.general || []);
}

function canonical(provider, model) {
  return `${provider}/${String(model || '').replace(/^\/+/, '')}`;
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
  // NVIDIA's own namespace is also named "nvidia". Keep a readable single-prefix
  // canonical id while restoring the provider namespace for the API request.
  if (provider === 'nvidia' && /^(?:nemotron|llama-.*nemotron)/i.test(actual)) actual = `nvidia/${actual}`;
  return { provider, model: actual, canonical: value };
}

function providerForModel(model) {
  return parse(model).provider;
}

function isDirectModel(model) {
  return Boolean(providerForModel(model));
}

async function credentialMap() {
  let stored = {};
  try { stored = await loadCredentials(); } catch {}
  const out = {};
  for (const [provider, cfg] of Object.entries(PROVIDERS)) {
    out[provider] = '';
    for (const key of cfg.keys) {
      const value = String(process.env[key] || stored[key] || '').trim();
      if (value) { out[provider] = value; break; }
    }
  }
  return out;
}

async function configuredProviders() {
  const creds = await credentialMap();
  return Object.keys(PROVIDERS).filter((provider) => Boolean(creds[provider]));
}

function cooling(model) {
  const until = cooldowns.get(String(model));
  if (!until || until <= Date.now()) { cooldowns.delete(String(model)); return false; }
  return true;
}

function markFailure(model) {
  cooldowns.set(String(model), Date.now() + COOLDOWN_MS);
}

function markSuccess(model) {
  cooldowns.delete(String(model));
}

async function candidates(taskType = 'general') {
  if (!enabled()) return [];
  const creds = await credentialMap();
  const out = [];
  for (const provider of providerOrder(taskType)) {
    if (!creds[provider]) continue;
    for (const model of modelList(provider, taskType)) {
      const id = canonical(provider, model);
      if (!cooling(id)) out.push(id);
    }
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

function errorFor(provider, response, raw) {
  const error = new Error(`${provider} direct HTTP ${response.status}: ${String(raw || '').slice(0, 1000)}`);
  error.status = response.status;
  error.raw = raw;
  error.directProvider = provider;
  return error;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

function openAiTools(tools) {
  return Array.isArray(tools) && tools.length ? tools : undefined;
}

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

function geminiResult(data, parsed) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const content = parts.map((part) => part?.text || '').join('');
  const toolCalls = parts.filter((part) => part?.functionCall?.name).map((part, index) => ({
    id: `gemini-${Date.now()}-${index}`,
    type: 'function',
    function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) },
  }));
  if (!content.trim() && !toolCalls.length) throw new Error('Gemini direct API returned no visible text or tool calls.');
  return { content, toolCalls, model: parsed.canonical, provider: 'gemini', transport: 'direct', raw: data };
}

async function chat({ messages, model, tools = null, taskType = 'general', timeoutMs = null } = {}) {
  const parsed = parse(model);
  if (!parsed.provider) throw new Error(`Not a direct provider model: ${model}`);
  const creds = await credentialMap();
  const apiKey = creds[parsed.provider];
  if (!apiKey) throw new Error(`Direct provider ${parsed.provider} is not configured.`);
  const cfg = PROVIDERS[parsed.provider];
  const budget = Math.max(3000, Number(timeoutMs || timeoutFor(taskType)));
  try {
    if (cfg.family === 'gemini') {
      const url = `${cfg.baseUrl}/models/${encodeURIComponent(parsed.model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const response = await fetchWithTimeout(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(geminiPayload(messages, tools)) }, budget);
      const raw = await response.text();
      if (!response.ok) throw errorFor(parsed.provider, response, raw);
      let data = {};
      try { data = raw ? JSON.parse(raw) : {}; } catch { throw new Error('Gemini direct API returned invalid JSON.'); }
      const result = geminiResult(data, parsed);
      markSuccess(parsed.canonical);
      return result;
    }

    const response = await fetchWithTimeout(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: parsed.model, messages: normalizeMessages(messages), ...(openAiTools(tools) ? { tools: openAiTools(tools) } : {}) }),
    }, budget);
    const raw = await response.text();
    if (!response.ok) throw errorFor(parsed.provider, response, raw);
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { throw new Error(`${parsed.provider} direct API returned invalid JSON.`); }
    const message = data?.choices?.[0]?.message || {};
    const content = typeof message.content === 'string' ? message.content : '';
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (!content.trim() && !toolCalls.length) throw new Error(`${parsed.provider} direct API returned no visible text or tool calls.`);
    markSuccess(parsed.canonical);
    return { content, toolCalls, model: parsed.canonical, provider: parsed.provider, transport: 'direct', raw: data };
  } catch (error) {
    markFailure(parsed.canonical);
    throw error;
  }
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

async function streamChat({ messages, model, tools = null, taskType = 'general', onDelta, firstTokenTimeoutMs = null } = {}) {
  if (typeof onDelta !== 'function') throw new Error('Direct streaming requires onDelta.');
  if (Array.isArray(tools) && tools.length) {
    const data = await chat({ messages, model, tools, taskType, timeoutMs: timeoutFor(taskType) });
    if (data.content) onDelta(data.content, { model: data.model, provider: data.provider, transport: 'direct' });
    return data;
  }
  const parsed = parse(model);
  if (!parsed.provider) throw new Error(`Not a direct provider model: ${model}`);
  const creds = await credentialMap();
  const apiKey = creds[parsed.provider];
  if (!apiKey) throw new Error(`Direct provider ${parsed.provider} is not configured.`);
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
      const url = `${cfg.baseUrl}/models/${encodeURIComponent(parsed.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(geminiPayload(messages, null)), signal: controller.signal });
      if (!response.ok) { const raw = await response.text(); throw errorFor(parsed.provider, response, raw); }
      await readSse(response, async (raw) => {
        if (raw === '[DONE]') return;
        let data;
        try { data = JSON.parse(raw); } catch { return; }
        const text = (data?.candidates?.[0]?.content?.parts || []).map((part) => part?.text || '').join('');
        if (!text) return;
        seen();
        fullText += text;
        onDelta(text, { model: parsed.canonical, provider: parsed.provider, transport: 'direct' });
      });
    } else {
      const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: parsed.model, messages: normalizeMessages(messages), stream: true }),
        signal: controller.signal,
      });
      if (!response.ok) { const raw = await response.text(); throw errorFor(parsed.provider, response, raw); }
      await readSse(response, async (raw) => {
        if (raw === '[DONE]') return;
        let data;
        try { data = JSON.parse(raw); } catch { return; }
        const text = data?.choices?.[0]?.delta?.content || '';
        if (!text) return;
        seen();
        fullText += text;
        onDelta(text, { model: parsed.canonical, provider: parsed.provider, transport: 'direct' });
      });
    }
    if (!fullText.trim()) throw new Error(`${parsed.provider} direct stream returned no visible text.`);
    markSuccess(parsed.canonical);
    return { content: fullText, toolCalls: [], model: parsed.canonical, provider: parsed.provider, transport: 'direct', raw: null };
  } catch (error) {
    markFailure(parsed.canonical);
    throw error;
  } finally {
    clearTimeout(firstTimer);
    clearTimeout(totalTimer);
  }
}

async function health() {
  const creds = await credentialMap();
  const providers = Object.fromEntries(Object.keys(PROVIDERS).map((provider) => [provider, { configured: Boolean(creds[provider]), models: Boolean(creds[provider]) ? modelList(provider, 'general').map((model) => canonical(provider, model)) : [] }]));
  return {
    enabled: enabled(),
    configured: Object.values(providers).some((row) => row.configured),
    providers,
    providerOrder: {
      general: providerOrder('general'),
      simple_qa: providerOrder('simple_qa'),
      coding: providerOrder('coding'),
      planning: providerOrder('planning'),
    },
  };
}

module.exports = {
  PROVIDERS,
  DEFAULT_MODELS,
  enabled,
  parse,
  canonical,
  providerForModel,
  isDirectModel,
  credentialMap,
  configuredProviders,
  candidates,
  allConfiguredModels,
  chat,
  streamChat,
  health,
  timeoutFor,
};
