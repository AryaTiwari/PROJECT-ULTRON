const { synthesize: synthesizeNvidia } = require('./nvidia-tts');
const { synthesize: synthesizeFish } = require('./fish-tts-free');
const { config, available } = require('./config');

async function synthesize(text, options = {}) {
  if (!available()) throw new Error('ULTRON voice reference audio is not installed. Run npm run core:voice-setup.');
  const provider = String(options.provider || config.provider).toLowerCase();
  if (provider === 'fish-audio-s2.1-pro-free' || provider === 'fish') return synthesizeFish(text, options);
  if (provider === 'nvidia-magpie-zeroshot' || provider === 'nvidia') return synthesizeNvidia(text, options);
  if (provider === 'local-chatterbox') {
    const { synthesize: synthesizeLocal } = require('./local-chatterbox');
    return synthesizeLocal(text, options);
  }
  throw new Error(`Unsupported ULTRON TTS provider: ${provider}`);
}
module.exports = { synthesize, available };
