const { synthesize } = require('./local-tts');
const { available, config } = require('./config');
const { VoiceState, STATES } = require('./voice-state');
const { VoicePipeline } = require('./voice-pipeline');
const { playLocalAudio } = require('./playback');
const { WAKE_WORD, detect, extractCommand } = require('./wake-word');

let lastPlaybackKey = '';
let lastPlaybackAt = 0;
const DUPLICATE_WINDOW_MS = 8000;

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

async function speakAndPlay(text, options = {}) {
  const normalized = String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const now = Date.now();
  const dedupeKey = normalized;
  if (dedupeKey && dedupeKey === lastPlaybackKey && now - lastPlaybackAt < DUPLICATE_WINDOW_MS) {
    return { ok: true, deduplicated: true, reason: 'duplicate_voice_request', text: normalized };
  }
  const audio = await speak(text, options);
  if (!audio?.path) return audio;
  lastPlaybackKey = dedupeKey;
  lastPlaybackAt = Date.now();
  const playback = await playLocalAudio(audio.path, config.outputDir);
  return { ...audio, playback };
}

module.exports = { speak, speakAndPlay, synthesize, playLocalAudio, available, status, VoiceState, VoicePipeline, WAKE_WORD, detectWakeWord: detect, extractCommand };