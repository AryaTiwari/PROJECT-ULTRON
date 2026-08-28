const { synthesize: synthesizeNvidia } = require('./nvidia-tts');
const { synthesize: synthesizeLocal } = require('./local-chatterbox');
const { config } = require('./config');

async function synthesize(text, options = {}) {
  const provider = options.provider || config.provider;
  if (provider === 'nvidia-magpie-zeroshot') {
    return synthesizeNvidia(text, options);
  }
  if (provider === 'local-chatterbox') {
    return synthesizeLocal(text, options);
  }
  throw new Error(`Unsupported ULTRON TTS provider: ${provider}`);
}

module.exports = { synthesize };
