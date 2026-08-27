const { load: loadCredentials } = require('./credentials/local-store');

const DEFAULT_MODEL = process.env.ULTRON_DIRECT_MODEL || 'gemini-3.7-flash';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

async function resolveApiKey() {
  if (process.env.GEMINI_API_KEY) return String(process.env.GEMINI_API_KEY).trim();
  try {
    const credentials = await loadCredentials();
    return String(credentials.GEMINI_API_KEY || '').trim();
  } catch {
    return '';
  }
}

function normalizeContents(messages) {
  return messages
    .filter((m) => m && m.role !== 'system' && String(m.content || '').trim())
    .map((m) => ({
      role: m.role === 'assistant' || m.role === 'model' ? 'model' : 'user',
      parts: [{ text: String(m.content) }],
    }));
}

function extractText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((part) => part?.text || '').join('').trim();
}

async function chat({ messages, model } = {}) {
  const apiKey = await resolveApiKey();
  if (!apiKey) throw new Error('Direct Gemini is not configured: GEMINI_API_KEY is missing from environment/local credential vault.');
  if (!Array.isArray(messages) || !messages.length) throw new Error('Model request requires messages.');

  const system = messages.find((m) => m?.role === 'system')?.content || '';
  const contents = normalizeContents(messages);
  const selectedModel = (model && model !== 'auto' ? model : DEFAULT_MODEL).replace(/^models\//, '');
  const response = await fetch(`${ENDPOINT}/${encodeURIComponent(selectedModel)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      systemInstruction: system ? { parts: [{ text: String(system) }] } : undefined,
      contents,
      generationConfig: { thinkingConfig: { thinkingLevel: 'medium' } },
    }),
  });

  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  if (!response.ok) throw new Error(`Gemini HTTP ${response.status}: ${raw.slice(0, 800)}`);

  const content = extractText(data);
  if (!content) throw new Error('Gemini returned no response text.');
  return { content, toolCalls: [], model: data?.modelVersion || selectedModel, provider: 'gemini-direct', raw: data };
}

async function available() {
  return Boolean(await resolveApiKey());
}

module.exports = { chat, available, resolveApiKey };
