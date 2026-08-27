const OPEN_CODE_BASE_URL = String(process.env.OPENCODE_BASE_URL || 'http://127.0.0.1:4096').replace(/\/$/, '');

let sessionId = null;

async function request(path, options = {}) {
  const response = await fetch(`${OPEN_CODE_BASE_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  if (!response.ok) {
    const error = new Error(`OpenCode HTTP ${response.status}: ${raw.slice(0, 1000)}`);
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
  if (!sessionId) throw new Error('OpenCode did not return a session ID.');
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
  const sid = await ensureSession();
  const selection = parseModel(model);
  const system = messages.find((m) => m.role === 'system')?.content || '';
  const nonSystem = messages.filter((m) => m.role !== 'system');
  const user = nonSystem.length ? nonSystem[nonSystem.length - 1] : { content: '' };
  const prior = nonSystem.slice(0, -1);
  const context = prior.length ? `Conversation context:\n${prior.map((m) => `${m.role}: ${m.content}`).join('\n')}\n\n` : '';
  const text = `${context}${user.content || ''}`;
  const payload = {
    parts: [{ type: 'text', text }],
  };
  if (system) payload.system = system;
  if (selection.providerID && selection.modelID) payload.model = { providerID: selection.providerID, modelID: selection.modelID };
  const result = await request(`/session/${encodeURIComponent(sid)}/message`, { method: 'POST', body: JSON.stringify(payload) });
  const content = extractText(result.parts) || extractText(result?.message?.parts) || result?.info?.text || '';
  if (!content.trim()) throw new Error('OpenCode returned no response text.');
  const provider = selection.providerID || result?.info?.model?.providerID || 'opencode';
  const resolvedModel = selection.modelID || result?.info?.model?.modelID || 'auto';
  return { content, toolCalls: [], provider, model: provider === 'opencode' && resolvedModel !== 'auto' ? `opencode/${resolvedModel}` : `${provider}/${resolvedModel}`, raw: result };
}

async function health() {
  try {
    const response = await fetch(`${OPEN_CODE_BASE_URL}/session`);
    return { ok: response.ok, mode: 'opencode-server', baseUrl: OPEN_CODE_BASE_URL };
  } catch (error) {
    return { ok: false, mode: 'opencode-server', baseUrl: OPEN_CODE_BASE_URL, error: error.message };
  }
}

function resetSession() { sessionId = null; }

module.exports = { chat, health, resetSession, parseModel, OPEN_CODE_BASE_URL };
