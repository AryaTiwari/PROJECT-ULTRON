const config = {
  provider: process.env.ULTRON_TTS_PROVIDER || 'fish',
  apiKey: process.env.FISH_API_KEY || '',
  endpoint: process.env.FISH_TTS_URL || 'https://api.fish.audio/v1/tts',
  model: process.env.FISH_TTS_MODEL || 's2.1-pro-free',
  referenceId: process.env.FISH_TTS_REFERENCE_ID || 'a0739d5765be4143a15dc37f91f19163',
  format: process.env.FISH_TTS_FORMAT || 'mp3',
  outputDir: process.env.ULTRON_TTS_OUTPUT_DIR || '.ultron/audio',
};

function available() {
  return config.provider === 'fish' && Boolean(config.apiKey && config.referenceId);
}

module.exports = { config, available };
