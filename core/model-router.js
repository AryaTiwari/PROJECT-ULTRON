const { config } = require('./config');
const { load: loadCredentials } = require('./credentials/local-store');

async function resolveApiKey() {
  if (config.router.apiKey) return config.router.apiKey;
  try {
    const credentials = await loadCredentials();
    return String(credentials.OMNIROUTE_API_KEY || '').trim();
  } catch {
    return '';
  }
}

async function headers() {
  const base = { 'Content-Type': 'application/json' };
  const apiKey = await resolveApiKey();
  if (apiKey) base.Authorization = `Bearer ${apiKey}`;
  return base;
}

async function chat({ messages, model, tools = null } = {}) {
  if (!Array.isArray(messages) || !messages.length) throw new Error('Model request requires messages.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.router.timeoutMs);
  try {
    const body = { model: model || config.router.model, messages };
    if (Array.isArray(tools) && tools.length) body.tools = tools;
    const response = await fetch(config.router.endpoint, { method: 'POST', headers: await headers(), body: JSON.stringify(body), signal: controller.signal });
    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
    if (!response.ok) throw new Error(`OmniRoute HTTP ${response.status}: ${raw.slice(0, 800)}`);
    const message = data?.choices?.[0]?.message || {};
    const content = message.content ?? data?.choices?.[0]?.text ?? data?.output_text ?? data?.response ?? '';
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (!String(content).trim() && !toolCalls.length) throw new Error('OmniRoute returned no response text or tool calls.');
    return { content: String(content || ''), toolCalls, model: data?.model || model || config.router.model, raw: data };
  } finally { clearTimeout(timeout); }
}

async function health() {
  try {
    const apiKey = await resolveApiKey();
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    const response = await fetch(config.router.endpoint.replace(/\/chat\/completions$/, '/models'), { headers });
    return { ok: response.ok, status: response.status, authenticated: Boolean(apiKey) };
  } catch (error) { return { ok: false, error: error.message, authenticated: false }; }
}

module.exports = { chat, health };
