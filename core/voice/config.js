const fs = require('fs');
const path = require('path');

const EXACT_ULTRON_VOICE_ID = 'a3b75ca2c6f5465fa7e0289147d4bb03';
const ULTRON_TTS_MODEL = 's2-pro';
const VOICE_CLONE_STATE = path.resolve(process.env.ULTRON_VOICE_CLONE_STATE || '.ultron/voice-clone.json');

function readClonedVoiceId() {
  try {
    const state = JSON.parse(fs.readFileSync(VOICE_CLONE_STATE, 'utf8'));
    return String(state?.voiceId || state?.id || '').trim() || null;
  } catch {
    return null;
  }
}

const persistedVoiceId = readClonedVoiceId();

const config = {
  provider: 'fish',
  apiKey: process.env.FISH_API_KEY || '',
  endpoint: process.env.FISH_TTS_URL || 'https://api.fish.audio/v1/tts',
  model: ULTRON_TTS_MODEL,
  referenceId: persistedVoiceId || process.env.FISH_REFERENCE_ID || EXACT_ULTRON_VOICE_ID,
  format: process.env.FISH_TTS_FORMAT || 'mp3',
  outputDir: process.env.ULTRON_TTS_OUTPUT_DIR || '.ultron/audio',
  voiceStyle: process.env.ULTRON_VOICE_STYLE || 'subtle-metallic-cinematic',
  metallicMix: Number(process.env.ULTRON_METALLIC_MIX || 0.18),
  referenceSource: process.env.ULTRON_VOICE_REFERENCE_SOURCE || 'AryaTiwari/Interface1/Ultron reference MP3',
};

function available() {
  return Boolean(config.apiKey && config.referenceId);
}

module.exports = { config, available, EXACT_ULTRON_VOICE_ID, ULTRON_TTS_MODEL, readClonedVoiceId, VOICE_CLONE_STATE };
