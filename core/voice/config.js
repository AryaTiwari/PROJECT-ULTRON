const fs = require('fs');
const path = require('path');

const VOICE_ROOT = path.resolve(process.env.ULTRON_VOICE_ROOT || '.ultron/voice');
const VOICE_CLONE_STATE = path.resolve(process.env.ULTRON_VOICE_CLONE_STATE || path.join(VOICE_ROOT, 'voice-clone.json'));
function readVoiceState() { try { return JSON.parse(fs.readFileSync(VOICE_CLONE_STATE, 'utf8')); } catch { return null; } }
const state = readVoiceState();

const requestedProvider = String(process.env.ULTRON_TTS_PROVIDER || '').trim().toLowerCase();
const fishCloneReady = Boolean(state?.fishVoiceId);
// A persisted Fish clone takes precedence so an old provider setting cannot disable it.
const provider = fishCloneReady ? 'fish-audio-s2.1-pro-free' : (requestedProvider === 'fish' ? 'fish-audio-s2.1-pro-free' : (requestedProvider || 'nvidia-magpie-zeroshot'));

const config = {
  provider,
  model: provider === 'fish-audio-s2.1-pro-free' ? (process.env.ULTRON_FISH_MODEL || 's2.1-pro-free') : (process.env.ULTRON_VOICE_MODEL || 'nvidia/magpie-tts-zeroshot'),
  engine: provider === 'fish-audio-s2.1-pro-free' ? 'fish-audio' : 'nvidia-magpie-zeroshot',
  referencePath: process.env.ULTRON_VOICE_REFERENCE_PATH || path.resolve('.ultron/voice/ultron-reference.mp3'),
  referenceSource: process.env.ULTRON_VOICE_REFERENCE_SOURCE || 'AryaTiwari/Interface1/Ultron-2026-08-27-11-05-[soft]-I-was-designed-to-[emphasis]-save-the-wor.mp3',
  cloneState: VOICE_CLONE_STATE,
  cloned: Boolean(state?.referencePath || state?.referencePrepared || state?.voiceProfileReady || state?.fishVoiceId),
  format: process.env.ULTRON_TTS_FORMAT || 'wav',
  outputDir: process.env.ULTRON_TTS_OUTPUT_DIR || '.ultron/audio',
  voiceStyle: process.env.ULTRON_VOICE_STYLE || 'subtle-metallic-cinematic',
  metallicMix: Number(process.env.ULTRON_METALLIC_MIX || 0.18),
  voiceQuality: Number(process.env.ULTRON_VOICE_QUALITY || 25),
};

function available() {
  return fs.existsSync(config.referencePath);
}

module.exports = { config, available, VOICE_CLONE_STATE, readVoiceState };
