const config = {
  provider: process.env.ULTRON_TTS_PROVIDER || 'fish',
  apiKey: process.env.FISH_API_KEY || '',
  endpoint: process.env.FISH_TTS_URL || 'https://api.fish.audio/v1/tts',
  model: process.env.FISH_TTS_MODEL || 's2.1-pro-free',
  referenceId: process.env.FISH_TTS_REFERENCE_ID || 'a3b75ca2c6f5465fa7e0289147d4bb03',
  format: process.env.FISH_TTS_FORMAT || 'mp3',
  outputDir: process.env.ULTRON_TTS_OUTPUT_DIR || '.ultron/audio',
  voiceStyle: process.env.ULTRON_VOICE_STYLE || 'subtle-metallic-cinematic',
  metallicMix: Number(process.env.ULTRON_METALLIC_MIX || 0.18),
};

function available() {
  return config.provider === 'fish' && Boolean(config.apiKey && config.referenceId);
}

module.exports = { config, available };
