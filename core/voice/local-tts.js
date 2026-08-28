const { synthesize: synthesizeNvidia } = require('./nvidia-tts');
const { config, available } = require('./config');

async function synthesize(text, options = {}) {
  if (!available()) throw new Error('ULTRON voice reference audio is not installed. Run npm run core:voice-setup.');
  const provider = options.provider || config.provider;
  if (provider === 'nvidia-magpie-zeroshot') return synthesizeNvidia(text, options);
  if (provider === 'local-chatterbox') {
    const { synthesize: synthesizeLocal } = require('./local-chatterbox');
    return synthesizeLocal(text, options);
  }
  throw new Error(`Unsupported ULTRON TTS provider: ${provider}`);
}
module.exports = { synthesize, available };