const path = require('path');
const config = require('./config');
const { readJson, writeJsonAtomic } = require('./persistence');
const { emit } = require('./events');
const integrations = require('./integrations');

const voiceStatePath = path.join(config.dataDir, 'voice-state.json');
let voiceState = readJson(voiceStatePath, { enabled: true });
let queue = Promise.resolve();
let speaking = false;
let generation = 0;

function clean(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[#*_`>\[\]{}|~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitSpeech(text, maxChars = 260) {
  const cleanText = clean(text);
  if (!cleanText) return [];
  const sentences = cleanText.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) || [cleanText];
  const chunks = [];
  for (const sentence of sentences) {
    const value = sentence.trim();
    if (!value) continue;
    if (value.length <= maxChars) { chunks.push(value); continue; }
    const words = value.split(/\s+/);
    let current = '';
    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (next.length > maxChars && current) { chunks.push(current); current = word; }
      else current = next;
    }
    if (current) chunks.push(current);
  }
  return chunks;
}

function isEnabled() {
  return voiceState.enabled !== false;
}

function setEnabled(enabled) {
  const next = Boolean(enabled);
  voiceState = { enabled: next, updatedAt: new Date().toISOString() };
  writeJsonAtomic(voiceStatePath, voiceState);
  generation += 1;
  if (!next) speaking = false;
  emit('voice_state_changed', { enabled: next });
  return status();
}

async function speakChunk(text, index, total, token) {
  if (!isEnabled() || token !== generation) return null;
  emit('voice_started', { index, total, text });
  const audio = await integrations.speak(text);
  if (!isEnabled() || token !== generation) return null;
  const filename = path.basename(String(audio?.path || ''));
  if (!filename) throw new Error('Voice synthesis returned no audio file.');
  const audioUrl = `/api/audio?path=${encodeURIComponent(filename)}`;
  emit('voice_ready', {
    index,
    total,
    filename,
    audioUrl,
    provider: audio.provider || 'unknown',
    model: audio.model || null,
    fallback: Boolean(audio.fallback),
    primaryError: audio.primaryError || null,
  });
  return audio;
}

function enqueue(text) {
  if (!isEnabled()) return Promise.resolve({ skipped: true, reason: 'voice-disabled' });
  // Response finishing happens before this layer. Never silently append a generic
  // “next command” line here; spoken audio and transcript must remain identical.
  const spokenText = String(text || '').trim();
  const chunks = splitSpeech(spokenText);
  if (!chunks.length) return queue;
  const token = generation;
  queue = queue.then(async () => {
    if (!isEnabled() || token !== generation) return;
    speaking = true;
    try {
      for (let i = 0; i < chunks.length; i += 1) {
        if (!isEnabled() || token !== generation) break;
        const audio = await speakChunk(chunks[i], i + 1, chunks.length, token);
        if (!audio) break;
        if (i < chunks.length - 1 && isEnabled() && token === generation) emit('voice_prefetch_next', { index: i + 2, total: chunks.length });
      }
      if (isEnabled() && token === generation) emit('voice_completed', { total: chunks.length });
    } catch (error) {
      if (isEnabled() && token === generation) emit('voice_error', { error: error.message, total: chunks.length });
    } finally {
      speaking = false;
    }
  });
  return queue;
}

function status() {
  return { enabled: isEnabled(), speaking, statePath: voiceStatePath, ...integrations.voiceStatus() };
}

module.exports = { enqueue, splitSpeech, clean, status, setEnabled, isEnabled };
