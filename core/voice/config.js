const fs = require('fs');
const path = require('path');

const VOICE_ROOT = path.resolve(process.env.ULTRON_VOICE_ROOT || '.ultron/voice/chatterbox');
const VOICE_CLONE_STATE = path.resolve(process.env.ULTRON_VOICE_CLONE_STATE || '.ultron/voice/voice-clone.json');
function readVoiceState() { try { return JSON.parse(fs.readFileSync(VOICE_CLONE_STATE, 'utf8')); } catch { return null; } }
const state = readVoiceState();
const localPython = process.platform === 'win32' ? path.join(VOICE_ROOT, '.venv', 'Scripts', 'python.exe') : path.join(VOICE_ROOT, '.venv', 'bin', 'python');
const config = {
  provider: process.env.ULTRON_TTS_PROVIDER || 'nvidia-magpie-zeroshot',
  model: process.env.ULTRON_VOICE_MODEL || 'nvidia/magpie-tts-zeroshot',
  engine: process.env.ULTRON_VOICE_ENGINE || 'nvidia-magpie-zeroshot',
  referencePath: process.env.ULTRON_VOICE_REFERENCE_PATH || path.resolve('.ultron/voice/ultron-reference.mp3'),
  referenceSource: 'AryaTiwari/Interface1/Ultron-2026-08-27-11-05-[soft]-I-was-designed-to-[emphasis]-save-the-wor.mp3',
  cloneState: VOICE_CLONE_STATE,
  cloned: Boolean(state?.referencePath || state?.voiceProfileReady),
  format: process.env.ULTRON_TTS_FORMAT || 'wav',
  outputDir: process.env.ULTRON_TTS_OUTPUT_DIR || '.ultron/audio',
  voiceStyle: process.env.ULTRON_VOICE_STYLE || 'subtle-metallic-cinematic',
  metallicMix: Number(process.env.ULTRON_METALLIC_MIX || 0.18),
  python: process.env.ULTRON_VOICE_PYTHON || localPython,
  serviceHost: process.env.ULTRON_VOICE_HOST || '127.0.0.1',
  servicePort: Number(process.env.ULTRON_VOICE_PORT || 8790),
};
function available() { return fs.existsSync(config.referencePath); }
module.exports = { config, available, VOICE_CLONE_STATE, readVoiceState };
