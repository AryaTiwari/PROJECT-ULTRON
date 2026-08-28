const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { config } = require('./config');
const { processMetallic } = require('./metallic-postprocess');
const credentialStore = require('../credentials/local-store');

const execFileAsync = promisify(execFile);
const REFERENCE_URL = process.env.ULTRON_VOICE_REFERENCE_URL || 'https://raw.githubusercontent.com/AryaTiwari/Interface1/main/Ultron-2026-08-27-11-05-%5Bsoft%5D-I-was-designed-to-[emphasis]-save-the-wor.mp3';
const NVIDIA_API_URL = process.env.NVIDIA_TTS_URL || 'https://integrate.api.nvidia.com/v1/audio/synthesize';
const NVIDIA_STREAM_URL = process.env.NVIDIA_TTS_STREAM_URL || 'https://integrate.api.nvidia.com/v1/audio/synthesize_online';

async function getApiKey() {
  const envKey = String(process.env.NVIDIA_API_KEY || '').trim();
  if (envKey) return envKey;
  try { const stored = await credentialStore.load(); return String(stored.NVIDIA_API_KEY || '').trim(); } catch { return ''; }
}

async function ensureReferenceSource() {
  const source = config.referencePath;
  if (fs.existsSync(source) && fs.statSync(source).size > 0) return source;
  fs.mkdirSync(path.dirname(source), { recursive: true });
  const response = await fetch(REFERENCE_URL, { headers: { 'User-Agent': 'PROJECT-ULTRON/Mark2' } });
  if (!response.ok) throw new Error(`Unable to fetch ULTRON voice reference: HTTP ${response.status}`);
  const audio = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(source, audio);
  return source;
}

async function ensureReferenceWav() {
  const source = await ensureReferenceSource();
  const wav = path.resolve(path.join(path.dirname(source), 'ultron-reference-magpie.wav'));
  if (fs.existsSync(wav) && fs.statSync(wav).mtimeMs >= fs.statSync(source).mtimeMs) return wav;
  await execFileAsync('ffmpeg', ['-y', '-i', source, '-t', '5', '-ar', '22050', '-ac', '1', '-sample_fmt', 's16', wav], { windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  return wav;
}

function buildForm(text, reference, options = {}) {
  const form = new FormData();
  form.append('language', options.language || 'en-US');
  form.append('text', String(text).slice(0, 2000));
  form.append('voice', options.voice || 'Magpie-ZeroShot-Multilingual');
  form.append('sample_rate_hz', String(options.sampleRate || 22050));
  form.append('prompt_quality', String(options.quality || process.env.ULTRON_VOICE_QUALITY || 20));
  form.append('audio_prompt', new Blob([fs.readFileSync(reference)], { type: 'audio/wav' }), 'ultron-reference-magpie.wav');
  return form;
}

async function synthesize(text, options = {}) {
  const input = String(text || '').trim();
  if (!input) throw new Error('TTS requires text.');
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('NVIDIA API key is not configured. Add NVIDIA_API_KEY to .env or ULTRON credentials.');

  const reference = await ensureReferenceWav();
  const response = await fetch(NVIDIA_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: buildForm(input, reference, options),
  });
  if (!response.ok) throw new Error(`NVIDIA Magpie TTS HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);

  const audio = Buffer.from(await response.arrayBuffer());
  const outputDir = path.resolve(options.outputDir || config.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.resolve(outputDir, options.filename || `ultron-${Date.now()}.wav`);
  fs.writeFileSync(outputPath, audio);
  const processed = await processMetallic(outputPath, outputPath);
  const finalPath = processed.path || outputPath;
  return {
    ok: true,
    provider: 'nvidia-magpie-zeroshot',
    model: 'nvidia/magpie-tts-zeroshot',
    referencePath: config.referencePath,
    path: finalPath,
    bytes: fs.statSync(finalPath).size,
    metallicApplied: processed.applied,
    metallicMix: config.metallicMix,
  };
}

module.exports = { synthesize, getApiKey, ensureReferenceWav, ensureReferenceSource, NVIDIA_API_URL, NVIDIA_STREAM_URL };