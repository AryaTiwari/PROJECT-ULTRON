const { config } = require('./config');
const directGemini = require('./direct-gemini');
const { load: loadCredentials } = require('./credentials/local-store');

async function resolveOmniRouteApiKey() {
  if (config.router.apiKey) return config.router.apiKey;
  try {
    const credentials = await loadCredentials();
    return String(credentials.OMNIROUTE_API_KEY || '').trim();
  } catch {
    return '';
  }
}

async function omniHeaders() {
  const base = { 'Content-Type': 'application/json' };
  const apiKey = await resolveOmniRouteApiKey();
  if (apiKey) base.Authorization = `Bearer ${apiKey}`;
  return base;
}

async function chatViaOmniRoute({ messages, model, tools = null } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.router.timeoutMs);
  try {
    const body = { model: model || config.router.model, messages };
    if (Array.isArray(tools) && tools.length) body.tools = tools;
    const response = await fetch(config.router.endpoint, { method: 'POST', headers: await omniHeaders(), body: JSON.stringify(body), signal: controller.signal });
    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
    if (!response.ok) throw new Error(`OmniRoute HTTP ${response.status}: ${raw.slice(0, 800)}`);
    const message = data?.choices?.[0]?.message || {};
    const content = message.content ?? data?.choices?.[0]?.text ?? data?.output_text ?? data?.response ?? '';
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (!String(content).trim() && !toolCalls.length) throw new Error('OmniRoute returned no response text or tool calls.');
    return { content: String(content || ''), toolCalls, model: data?.model || model || config.router.model, provider: 'omniroute', raw: data };
  } finally { clearTimeout(timeout); }
}

async function chat({ messages, model, tools = null } = {}) {
  if (!Array.isArray(messages) || !messages.length) throw new Error('Model request requires messages.');

  const mode = String(process.env.ULTRON_MODEL_PROVIDER || 'direct').toLowerCase();

  // Direct Gemini is the primary path so ULTRON does not require an OmniRoute
  // provider merely to hold a conversation. OmniRoute remains available as an
  // explicit mode or fallback when direct Gemini is unavailable.
  if (mode !== 'omniroute' && await directGemini.available()) {
    try {
      return await directGemini.chat({ messages, model });
    } catch (directError) {
      if (mode === 'direct') throw directError;
    }
  }

  const omniErrorMode = mode === 'omniroute' || mode === 'auto' || mode === 'direct-fallback';
  if (omniErrorMode) {
    try {
      return await chatViaOmniRoute({ messages, model, tools });
    } catch (omniError) {
      if (mode === 'direct-fallback') throw omniError;
      if (await directGemini.available()) {
        return await directGemini.chat({ messages, model });
      }
      throw omniError;
    }
  }

  throw new Error('No model provider is configured. Add GEMINI_API_KEY to the local credential vault or select ULTRON_MODEL_PROVIDER=omniroute.');
}

async function health() {
  const direct = await directGemini.available();
  if (direct) return { ok: true, provider: 'gemini-direct', authenticated: true };
  try {
    const apiKey = await resolveOmniRouteApiKey();
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    const response = await fetch(config.router.endpoint.replace(/\/chat\/completions$/, '/models'), { headers });
    return { ok: response.ok, status: response.status, provider: 'omniroute', authenticated: Boolean(apiKey) };
  } catch (error) { return { ok: false, error: error.message, provider: 'omniroute', authenticated: false }; }
}

module.exports = { chat, health, chatViaOmniRoute };
