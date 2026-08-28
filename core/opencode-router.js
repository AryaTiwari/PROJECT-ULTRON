const http = require('http');

const OPEN_CODE_BASE_URL = String(process.env.OPENCODE_BASE_URL || 'http://127.0.0.1:4096').replace(/\/$/, '');
const OPEN_CODE_URL = new URL(OPEN_CODE_BASE_URL);

let sessionId = null;

function nativeRequest(pathname, options = {}) {
  const url = new URL(pathname, OPEN_CODE_BASE_URL + '/');
  const body = options.body == null ? '' : String(options.body);
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (body) headers['Content-Length'] = Buffer.byteLength(body);

  return new Promise((resolve, reject) => {
    const request = http.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 80,
      method: options.method || 'GET',
      path: `${url.pathname}${url.search}`,
      headers,
      agent: false,
    }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { raw += chunk; });
      response.on('end', () => resolve({
        ok: (response.statusCode || 500) >= 200 && (response.statusCode || 500) < 300,
        status: response.statusCode || 500,
        statusText: response.statusMessage || '',
        raw,
      }));
    });
    request.setTimeout(15000, () => request.destroy(new Error('Local OpenCode request timed out.')));
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

async function request(pathname, options = {}) {
  const url = `${OPEN_CODE_BASE_URL}${pathname}`;
  let result;
  try {
    result = await nativeRequest(pathname, options);
  } catch (error) {
    throw new Error(`OpenCode connection failed (${url}): ${error?.message || String(error)}`);
  }
  let data = {};
  try { data = result.raw ? JSON.parse(result.raw) : {}; } catch { data = { raw: result.raw }; }
  if (!result.ok) {
    const error = new Error(`OpenCode HTTP ${result.status} ${result.statusText}: ${result.raw.slice(0, 1200)}`);
    error.status = result.status;
    throw error;
  }
  return data;
}

async function ensureSession() {
  if (sessionId) {
    try { await request(`/session/${encodeURIComponent(sessionId)}`); return sessionId; }
    catch { sessionId = null; }
  }
  const session = await request('/session', { method: 'POST', body: JSON.stringify({ title: 'ULTRON Mark 2' }) });
  sessionId = session.id || session.sessionID;
  if (!sessionId) throw new Error(`OpenCode session creation returned no session ID. Response: ${JSON.stringify(session).slice(0, 800)}`);
  return sessionId;
}

function parseModel(model) {
  const value = String(model || 'auto').trim();
  if (!value || value === 'auto') return { providerID: null, modelID: null };
  const slash = value.indexOf('/');
  if (slash < 0) return { providerID: null, modelID: value };
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) };
}

function extractText(parts) {
  if (!Array.isArray(parts)) return '';
  return parts.filter((part) => part?.type === 'text').map((part) => part.text || '').join('');
}

async function chat({ messages, model = 'auto' } = {}) {
  if (!Array.isArray(messages) || !messages.length) throw new Error('Model request requires messages.');
  const health = await request('/global/health');
  if (health?.healthy === false) throw new Error(`OpenCode server reports unhealthy state. Version: ${health?.version || 'unknown'}`);
  const sid = await ensureSession();
  const selection = parseModel(model);
  const system = messages.find((m) => m.role === 'system')?.content || '';
  const nonSystem = messages.filter((m) => m.role !== 'system');
  const user = nonSystem.length ? nonSystem[nonSystem.length - 1] : { content: '' };
  const prior = nonSystem.slice(0, -1);
  const context = prior.length ? `Conversation context:\n${prior.map((m) => `${m.role}: ${m.content}`).join('\n')}\n\n` : '';
  const text = `${context}${user.content || ''}`;
  const payload = { parts: [{ type: 'text', text }] };
  if (system) payload.system = system;
  if (selection.providerID && selection.modelID) payload.model = { providerID: selection.providerID, modelID: selection.modelID };
  const result = await request(`/session/${encodeURIComponent(sid)}/message`, { method: 'POST', body: JSON.stringify(payload) });
  const content = extractText(result.parts) || extractText(result?.message?.parts) || extractText(result?.info?.parts) || result?.info?.text || '';
  if (!content.trim()) throw new Error(`OpenCode returned no response text. Raw response: ${JSON.stringify(result).slice(0, 1200)}`);
  const provider = selection.providerID || result?.info?.model?.providerID || 'opencode';
  const resolvedModel = selection.modelID || result?.info?.model?.modelID || 'auto';
  return { content, toolCalls: [], provider, model: provider === 'opencode' && resolvedModel !== 'auto' ? `opencode/${resolvedModel}` : `${provider}/${resolvedModel}`, raw: result };
}

async function health() {
  try {
    const data = await request('/global/health');
    return { ok: Boolean(data?.healthy), mode: 'opencode-server', baseUrl: OPEN_CODE_BASE_URL, version: data?.version || null };
  } catch (error) {
    return { ok: false, mode: 'opencode-server', baseUrl: OPEN_CODE_BASE_URL, error: error.message };
  }
}

function resetSession() { sessionId = null; }

module.exports = { chat, health, resetSession, parseModel, OPEN_CODE_BASE_URL, OPEN_CODE_URL };
