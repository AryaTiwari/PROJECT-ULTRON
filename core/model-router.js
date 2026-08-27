const { config } = require('./config');
const direct = require('./direct-model-router');
const openCode = require('./opencode-router');
const { load: loadCredentials } = require('./credentials/local-store');

async function resolveOmniRouteApiKey() {
  if (config.router.apiKey) return config.router.apiKey;
  try { const credentials = await loadCredentials(); return String(credentials.OMNIROUTE_API_KEY || '').trim(); }
  catch { return ''; }
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

function isOmniRouteModel(model) {
  return String(model || '').trim().toLowerCase().startsWith('omniroute/');
}

async function chat({ messages, model, tools = null } = {}) {
  if (!Array.isArray(messages) || !messages.length) throw new Error('Model request requires messages.');
  const requestedModel = model || config.router.model;
  const mode = String(process.env.ULTRON_MODEL_PROVIDER || 'opencode-server').toLowerCase();

  // `omniroute/<catalog-model>` is explicitly transported through the
  // OpenCode custom provider configured from OmniRoute's live /v1/models catalog.
  // This keeps OmniRoute's full model catalog without making its raw API the
  // primary ULTRON transport.
  if (isOmniRouteModel(requestedModel)) return openCode.chat({ messages, model: requestedModel, tools });

  if (mode === 'opencode-server' || mode === 'opencode') {
    return openCode.chat({ messages, model: requestedModel, tools });
  }
  if (mode === 'direct') return direct.directChat({ messages, model: requestedModel, tools });

  if (mode === 'auto') {
    try { return await openCode.chat({ messages, model: requestedModel, tools }); }
    catch (openCodeError) {
      try { return await direct.directChat({ messages, model: requestedModel, tools }); }
      catch (directError) { throw new Error(`OpenCode and direct model routing both failed. OpenCode: ${openCodeError.message}. Direct: ${directError.message}`); }
    }
  }
  if (mode === 'omniroute') return chatViaOmniRoute({ messages, model: requestedModel, tools });
  throw new Error('No model provider mode is configured. Use opencode-server (default), direct, auto, or omniroute.');
}

async function health() {
  const openCodeHealth = await openCode.health();
  const directHealth = await direct.health();
  if (openCodeHealth.ok) return { ok: true, mode: 'opencode-server', ...openCodeHealth, direct: directHealth };
  if (directHealth.anyConfigured) return { ok: true, mode: 'direct', direct: directHealth, opencode: openCodeHealth };
  try {
    const apiKey = await resolveOmniRouteApiKey();
    const response = await fetch(config.router.endpoint.replace(/\/chat\/completions$/, '/models'), { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} });
    return { ok: response.ok, status: response.status, mode: 'omniroute-legacy', authenticated: Boolean(apiKey), openCode: openCodeHealth };
  } catch (error) { return { ok: false, error: error.message, mode: 'no-router', openCode: openCodeHealth }; }
}

module.exports = { chat, health, chatViaOmniRoute, isOmniRouteModel };
