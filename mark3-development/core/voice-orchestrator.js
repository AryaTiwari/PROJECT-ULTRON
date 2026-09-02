const path = require('path');
const { emit } = require('./events');
const integrations = require('./integrations');

let queue = Promise.resolve();
let speaking = false;

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

async function speakChunk(text, index, total) {
  emit('voice_started', { index, total, text });
  const audio = await integrations.speak(text);
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
  const chunks = splitSpeech(text);
  if (!chunks.length) return queue;
  queue = queue.then(async () => {
    speaking = true;
    try {
      for (let i = 0; i < chunks.length; i += 1) {
        await speakChunk(chunks[i], i + 1, chunks.length);
        if (i < chunks.length - 1) emit('voice_prefetch_next', { index: i + 2, total: chunks.length });
      }
      emit('voice_completed', { total: chunks.length });
    } catch (error) {
      emit('voice_error', { error: error.message, total: chunks.length });
    } finally {
      speaking = false;
    }
  });
  return queue;
}

function status() {
  return { speaking, ...integrations.voiceStatus() };
}

module.exports = { enqueue, splitSpeech, clean, status };
