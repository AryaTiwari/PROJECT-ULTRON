const config = require('./config');
const omniFallback = require('./omniroute-fallback');
const { load: loadCredentials } = require('../../core/credentials/local-store');

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_MODEL = String(process.env.ULTRON_M3_VOICE_STT_MODEL || 'whisper-large-v3-turbo').trim();
const PROVIDER_MODE = String(process.env.ULTRON_M3_NATIVE_VOICE_PROVIDER || 'auto').trim().toLowerCase();
const TIMEOUT_MS = Math.max(10000, Number(process.env.ULTRON_M3_NATIVE_VOICE_TIMEOUT_MS || 45000));
let groqIndex = 0;

async function stored() {
  try { return await loadCredentials(); } catch { return {}; }
}

async function groqKeys() {
  const saved = await stored();
  const rows = [
    ['GROQ_API_KEY', process.env.GROQ_API_KEY || saved.GROQ_API_KEY],
    ['GROQ_API_KEY2', process.env.GROQ_API_KEY2 || saved.GROQ_API_KEY2],
  ].map(([slot, value]) => ({ slot, value: String(value || '').trim() })).filter((row) => row.value);
  const seen = new Set();
  return rows.filter((row) => !seen.has(row.value) && seen.add(row.value));
}

async function omniKey() {
  const saved = await stored();
  return String(process.env.OMNIROUTE_ENDPOINT_KEY || process.env.OMNIROUTE_API_KEY || process.env.ULTRON_OMNIROUTE_API_KEY || saved.OMNIROUTE_ENDPOINT_KEY || saved.OMNIROUTE_API_KEY || saved.ULTRON_OMNIROUTE_API_KEY || '').trim();
}

function timeoutController(ms = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { controller, done: () => clearTimeout(timer) };
}

function audioForm(buffer, { name = 'voice.webm', mime = 'audio/webm', model, language = 'en' } = {}) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime || 'application/octet-stream' }), name);
  form.append('model', model);
  form.append('response_format', 'json');
  if (language) form.append('language', language);
  return form;
}

async function transcribeGroq(buffer, options = {}) {
  const keys = await groqKeys();
  if (!keys.length) throw new Error('Groq transcription is not configured.');
  const ordered = [...keys.slice(groqIndex % keys.length), ...keys.slice(0, groqIndex % keys.length)];
  let lastError = null;

  for (let i = 0; i < ordered.length; i += 1) {
    const entry = ordered[i];
    const { controller, done } = timeoutController();
    try {
      const response = await fetch(GROQ_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${entry.value}` },
        body: audioForm(buffer, { ...options, model: GROQ_MODEL }),
        signal: controller.signal,
      });
      const raw = await response.text();
      if (!response.ok) {
        const error = new Error(`Groq transcription HTTP ${response.status} via ${entry.slot}: ${raw.slice(0, 500)}`);
        error.status = response.status;
        throw error;
      }
      const data = raw ? JSON.parse(raw) : {};
      const text = String(data?.text || '').trim();
      if (!text) throw new Error('Groq transcription returned no text.');
      groqIndex = (keys.findIndex((row) => row.slot === entry.slot) + 1) % keys.length;
      return { text, provider: 'groq-stt', model: GROQ_MODEL, credentialSlot: entry.slot };
    } catch (error) {
      lastError = error;
      const status = Number(error?.status || 0);
      if (![401, 403, 429].includes(status)) break;
    } finally { done(); }
  }
  throw lastError || new Error('Groq transcription failed.');
}

function omniTranscriptionModel() {
  return String(process.env.ULTRON_M3_OMNIROUTE_STT_MODEL || process.env.ULTRON_M3_VOICE_STT_MODEL || 'whisper-1').trim();
}

async function transcribeOmniRoute(buffer, options = {}) {
  await omniFallback.ensure({ reason: 'native voice transcription fallback' });
  const model = omniTranscriptionModel();
  const key = await omniKey();
  const { controller, done } = timeoutController();
  try {
    const response = await fetch(`${config.omnirouteBase}/audio/transcriptions`, {
      method: 'POST',
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      body: audioForm(buffer, { ...options, model }),
      signal: controller.signal,
    });
    const raw = await response.text();
    if (!response.ok) {
      const error = new Error(`OmniRoute transcription HTTP ${response.status}: ${raw.slice(0, 700)}`);
      error.status = response.status;
      throw error;
    }
    const data = raw ? JSON.parse(raw) : {};
    const text = String(data?.text || data?.transcript || data?.output_text || '').trim();
    if (!text) throw new Error('OmniRoute transcription returned no text.');
    return { text, provider: 'omniroute-stt', model };
  } finally { done(); }
}

function cleanTranscript(text) {
  return String(text || '')
    .trim()
    .replace(/^(?:hey\s+)?(?:ultron|ultran|altron|oltron|ultra\s+on)\b[\s,:;.!-]*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function transcribe(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Voice audio is empty.');
  const failures = [];
  const modes = PROVIDER_MODE === 'groq' ? ['groq'] : PROVIDER_MODE === 'omniroute' ? ['omniroute'] : ['groq', 'omniroute'];
  for (const mode of modes) {
    try {
      const result = mode === 'groq' ? await transcribeGroq(buffer, options) : await transcribeOmniRoute(buffer, options);
      return { ...result, text: cleanTranscript(result.text), rawText: result.text };
    } catch (error) {
      failures.push(`${mode}: ${error.message}`);
    }
  }
  const error = new Error(`Native voice recognition failed. ${failures.join(' | ')}`);
  error.failures = failures;
  throw error;
}

async function status() {
  const keys = await groqKeys();
  return {
    enabled: !/^(0|false|no|off)$/i.test(String(process.env.ULTRON_M3_NATIVE_VOICE_ENABLED || '1')),
    mode: PROVIDER_MODE,
    primary: PROVIDER_MODE === 'omniroute' ? 'omniroute-stt' : 'groq-stt',
    groqKeys: keys.map((row) => row.slot),
    omnirouteFallback: true,
    omnirouteModel: omniTranscriptionModel(),
    browserFallback: true,
  };
}

module.exports = { transcribe, transcribeGroq, transcribeOmniRoute, cleanTranscript, status };
