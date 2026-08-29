const { synthesize } = require('./local-tts');
const { available, config } = require('./config');
const { VoiceState, STATES } = require('./voice-state');
const { VoicePipeline } = require('./voice-pipeline');
const { playLocalAudio } = require('./playback');
const { WAKE_WORD, detect, extractCommand } = require('./wake-word');

const DUPLICATE_WINDOW_MS = 15000;
const inFlight = new Map();
const recentSpeech = new Map();

function speechKey(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

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
  const key = speechKey(text);
  if (!key) return { ok: false, error: 'TTS requires text.' };

  const now = Date.now();
  const recent = recentSpeech.get(key);
  if (recent && now - recent < DUPLICATE_WINDOW_MS) {
    return { ok: true, deduplicated: true, reason: 'duplicate_voice_request' };
  }

  const existing = inFlight.get(key);
  if (existing) {
    const result = await existing;
    return { ...result, deduplicated: true, reason: 'duplicate_inflight_voice_request' };
  }

  const run = (async () => {
    const audio = await speak(text, options);
    if (!audio?.path) return audio;

    recentSpeech.set(key, Date.now());
    const playback = await playLocalAudio(audio.path, config.outputDir);
    return { ...audio, playback };
  })();

  inFlight.set(key, run);

  try {
    return await run;
  } finally {
    if (inFlight.get(key) === run) inFlight.delete(key);

    const timer = setTimeout(() => {
      if (recentSpeech.get(key) && Date.now() - recentSpeech.get(key) >= DUPLICATE_WINDOW_MS) {
        recentSpeech.delete(key);
      }
    }, DUPLICATE_WINDOW_MS + 250);
    timer.unref?.();
  }
}

module.exports = { speak, speakAndPlay, synthesize, playLocalAudio, available, status, VoiceState, VoicePipeline, WAKE_WORD, detectWakeWord: detect, extractCommand };