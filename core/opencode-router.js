const OPEN_CODE_BASE_URL = String(process.env.OPENCODE_BASE_URL || 'http://127.0.0.1:4096').replace(/\/$/, '');

let sessionId = null;

async function request(path, options = {}) {
  const url = `${OPEN_CODE_BASE_URL}${path}`;
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
  } catch (error) {
    const detail = error?.cause?.message ? `: ${error.cause.message}` : '';
    throw new Error(`OpenCode connection failed (${url})${detail || `: ${error?.message || String(error)}`}`);
  }
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  if (!response.ok) {
    const error = new Error(`OpenCode HTTP ${response.status} ${response.statusText}: ${raw.slice(0, 1200)}`);
    error.status = response.status;
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

module.exports = { chat, health, resetSession, parseModel, OPEN_CODE_BASE_URL };
