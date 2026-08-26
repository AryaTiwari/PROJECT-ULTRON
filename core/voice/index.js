const { synthesize } = require('./fish-tts');
const { available } = require('./config');

async function speak(text, options = {}) {
  if (!available()) return { ok: false, configured: false, reason: 'Fish Audio TTS is not configured.' };
  return synthesize(text, options);
}

module.exports = { speak, available };
