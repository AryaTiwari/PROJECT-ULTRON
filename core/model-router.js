const { config } = require('./config');
const direct = require('./direct-model-router');
const { load: loadCredentials } = require('./credentials/local-store');

async function resolveOmniRouteApiKey() {
  if (config.router.apiKey) return config.router.apiKey;
  try {
    const credentials = await loadCredentials();
    return String(credentials.OMNIROUTE_API_KEY || '').trim();
  } catch { return ''; }
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
    let data = {}; try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
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

  if (mode === 'direct' || mode === 'auto') {
    try { return await direct.directChat({ messages, model, tools }); }
    catch (directError) {
      if (mode === 'direct') throw directError;
    }
  }

  if (mode === 'omniroute' || mode === 'auto') {
    try { return await chatViaOmniRoute({ messages, model, tools }); }
    catch (omniError) {
      if (mode === 'auto') {
        try { return await direct.directChat({ messages, model, tools }); }
        catch (directError) {
          throw new Error(`Direct model and OmniRoute both failed. Direct: ${directError.message}. OmniRoute: ${omniError.message}`);
        }
      }
      throw omniError;
    }
  }

  throw new Error('No model provider mode is configured. Use ULTRON_MODEL_PROVIDER=direct (default) or omniroute.');
}

async function health() {
  const directHealth = await direct.health();
  if (directHealth.anyConfigured) return { ok: true, mode: 'direct', ...directHealth };
  try {
    const apiKey = await resolveOmniRouteApiKey();
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    const response = await fetch(config.router.endpoint.replace(/\/chat\/completions$/, '/models'), { headers });
    return { ok: response.ok, status: response.status, mode: 'omniroute', authenticated: Boolean(apiKey) };
  } catch (error) { return { ok: false, error: error.message, mode: 'omniroute', authenticated: false }; }
}

module.exports = { chat, health, chatViaOmniRoute };
