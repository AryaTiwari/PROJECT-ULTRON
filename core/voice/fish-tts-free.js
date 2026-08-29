const fs = require('fs');
const path = require('path');
const credentialStore = require('../credentials/local-store');
const { config } = require('./config');
const { processMetallic } = require('./metallic-postprocess');

const MODEL = process.env.ULTRON_FISH_MODEL || 's2.1-pro-free';

async function getApiKey() {
  const envKey = String(process.env.FISH_API_KEY || '').trim();
  if (envKey) return envKey;
  try {
    const stored = await credentialStore.load();
    return String(stored.FISH_API_KEY || '').trim();
  } catch {
    return '';
  }
}

function statePath() {
  return path.resolve(process.env.ULTRON_VOICE_CLONE_STATE || '.ultron/voice/voice-clone.json');
}

function readState() {
  try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch { return {}; }
}

async function client() {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('FISH_API_KEY is not configured. Add a free Fish Audio developer key to .env or ULTRON credentials.');
  const mod = await import('fish-audio');
  return { client: new mod.FishAudioClient({ apiKey }), apiKey, mod };
}

async function cloneVoice(options = {}) {
  const { client: fish } = await client();
  const reference = path.resolve(options.referencePath || config.referencePath);
  if (!fs.existsSync(reference)) throw new Error(`Voice reference not found: ${reference}`);
  const audioFile = fs.createReadStream(reference);
  const title = options.title || 'ULTRON Voice';
  const response = await fish.voices.ivc.create({ title, voices: [audioFile] });
  const state = readState();
  state.provider = 'fish-audio-s2.1-pro-free';
  state.engine = 'fish-audio';
  state.model = MODEL;
  state.referencePath = reference;
  state.voiceProfileReady = true;
  state.fishVoiceId = response._id;
  state.fishVoiceState = response.state;
  fs.mkdirSync(path.dirname(statePath()), { recursive: true });
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2), 'utf8');
  return { ok: true, voiceId: response._id, state: response.state, title: response.title };
}

async function streamToBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (value && typeof value.arrayBuffer === 'function') return Buffer.from(await value.arrayBuffer());

  if (value && typeof value.getReader === 'function') {
    const reader = value.getReader();
    const chunks = [];
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      if (chunk) chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  if (value && typeof value.on === 'function') {
    return await new Promise((resolve, reject) => {
      const chunks = [];
      value.on('data', chunk => chunks.push(Buffer.from(chunk)));
      value.on('end', () => resolve(Buffer.concat(chunks)));
      value.on('error', reject);
    });
  }

  throw new TypeError(`Unsupported Fish Audio response type: ${Object.prototype.toString.call(value)}`);
}

async function synthesize(text, options = {}) {
  const input = String(text || '').trim();
  if (!input) throw new Error('TTS requires text.');
  const { client: fish } = await client();
  const state = readState();
  const voiceId = String(options.referenceId || state.fishVoiceId || process.env.ULTRON_FISH_REFERENCE_ID || '').trim();
  if (!voiceId) throw new Error('ULTRON Fish voice clone is not configured. Run npm run core:voice-setup with FISH_API_KEY available.');

  const audio = await fish.textToSpeech.convert({
    text: input.slice(0, 4096),
    reference_id: voiceId,
    format: options.format || 'mp3',
    latency: options.latency || 'balanced',
    chunk_length: Number(options.chunkLength || 200),
    normalize: true,
    prosody: { speed: Number(options.speed || 1), volume: Number(options.volume || 0), normalize_loudness: true },
    temperature: Number(options.temperature ?? 0.65),
    top_p: Number(options.topP ?? 0.7),
  }, MODEL);

  const outputDir = path.resolve(options.outputDir || config.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });
  const ext = (options.format || 'mp3').toLowerCase() === 'wav' ? 'wav' : 'mp3';
  const outputPath = path.resolve(outputDir, options.filename || `ultron-${Date.now()}.${ext}`);
  const buffer = await streamToBuffer(audio);
  fs.writeFileSync(outputPath, buffer);
  const processed = await processMetallic(outputPath, outputPath);
  const finalPath = processed.path || outputPath;
  return {
    ok: true,
    provider: 'fish-audio-s2.1-pro-free',
    model: MODEL,
    referenceId: voiceId,
    referencePath: config.referencePath,
    path: finalPath,
    bytes: fs.statSync(finalPath).size,
    metallicApplied: processed.applied,
    metallicMix: config.metallicMix,
  };
}

module.exports = { synthesize, cloneVoice, getApiKey, readState, MODEL, streamToBuffer };
