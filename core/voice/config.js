const fs = require('fs');
const path = require('path');

const VOICE_ROOT = path.resolve(process.env.ULTRON_VOICE_ROOT || '.ultron/voice');
const VOICE_CLONE_STATE = path.resolve(process.env.ULTRON_VOICE_CLONE_STATE || path.join(VOICE_ROOT, 'voice-clone.json'));
function readVoiceState() { try { return JSON.parse(fs.readFileSync(VOICE_CLONE_STATE, 'utf8')); } catch { return null; } }
const state = readVoiceState();

const config = {
  provider: process.env.ULTRON_TTS_PROVIDER || 'nvidia-magpie-zeroshot',
  model: process.env.ULTRON_VOICE_MODEL || 'nvidia/magpie-tts-zeroshot',
  engine: process.env.ULTRON_VOICE_ENGINE || 'nvidia-magpie-zeroshot',
  referencePath: process.env.ULTRON_VOICE_REFERENCE_PATH || path.resolve('.ultron/voice/ultron-reference.mp3'),
  referenceSource: process.env.ULTRON_VOICE_REFERENCE_SOURCE || 'AryaTiwari/Interface1/Ultron-2026-08-27-11-05-[soft]-I-was-designed-to-[emphasis]-save-the-wor.mp3',
  cloneState: VOICE_CLONE_STATE,
  cloned: Boolean(state?.referencePath || state?.voiceProfileReady),
  format: process.env.ULTRON_TTS_FORMAT || 'wav',
  outputDir: process.env.ULTRON_TTS_OUTPUT_DIR || '.ultron/audio',
  voiceStyle: process.env.ULTRON_VOICE_STYLE || 'subtle-metallic-cinematic',
  metallicMix: Number(process.env.ULTRON_METALLIC_MIX || 0.18),
  voiceQuality: Number(process.env.ULTRON_VOICE_QUALITY || 20),
};

function available() {
  return fs.existsSync(config.referencePath);
}

module.exports = { config, available, VOICE_CLONE_STATE, readVoiceState };
