const fs = require('fs');
const path = require('path');

const VOICE_CLONE_STATE = path.resolve(process.env.ULTRON_VOICE_CLONE_STATE || '.ultron/voice-clone.json');

function readVoiceState() {
  try { return JSON.parse(fs.readFileSync(VOICE_CLONE_STATE, 'utf8')); } catch { return null; }
}

const state = readVoiceState();

const config = {
  provider: 'openvoice-v2-local',
  model: process.env.ULTRON_VOICE_MODEL || 'OpenVoiceV2',
  engine: process.env.ULTRON_VOICE_ENGINE || 'openvoice-v2',
  referencePath: process.env.ULTRON_VOICE_REFERENCE_PATH || path.resolve('.ultron/voice/ultron-reference.mp3'),
  referenceSource: 'AryaTiwari/Interface1/Ultron-2026-08-27-11-05-[soft]-I-was-designed-to-[emphasis]-save-the-wor.mp3',
  cloneState: VOICE_CLONE_STATE,
  cloned: Boolean(state?.voiceEmbedding || state?.referencePath),
  format: process.env.ULTRON_TTS_FORMAT || 'wav',
  outputDir: process.env.ULTRON_TTS_OUTPUT_DIR || '.ultron/audio',
  voiceStyle: process.env.ULTRON_VOICE_STYLE || 'subtle-metallic-cinematic',
  metallicMix: Number(process.env.ULTRON_METALLIC_MIX || 0.18),
  python: process.env.ULTRON_VOICE_PYTHON || 'python',
  serviceHost: process.env.ULTRON_VOICE_HOST || '127.0.0.1',
  servicePort: Number(process.env.ULTRON_VOICE_PORT || 8790),
};

function available() {
  return config.provider === 'openvoice-v2-local' && Boolean(fs.existsSync(config.referencePath));
}

module.exports = { config, available, VOICE_CLONE_STATE, readVoiceState };
