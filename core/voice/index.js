const { synthesize } = require('./local-tts');
const { available, config } = require('./config');
const { VoiceState, STATES } = require('./voice-state');
const { VoicePipeline } = require('./voice-pipeline');
const { WAKE_WORD, detect, extractCommand } = require('./wake-word');

function status() {
  return {
    provider: config.provider,
    configured: available(),
    model: config.model,
    referencePath: config.referencePath,
    referenceSource: config.referenceSource,
    cloned: config.cloned,
    wakeWord: WAKE_WORD,
    wakeWordPolicy: 'exact-first-word-only',
    states: STATES,
  };
}

async function speak(text, options = {}) {
  if (!available()) return { ok: false, configured: false, reason: 'ULTRON voice reference audio is not installed. Run npm run core:voice-setup.' };
  return synthesize(text, options);
}

module.exports = { speak, synthesize, available, status, VoiceState, VoicePipeline, WAKE_WORD, detectWakeWord: detect, extractCommand };
