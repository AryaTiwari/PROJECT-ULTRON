const WAKE_WORD = String(process.env.ULTRON_WAKE_WORD || 'ULTRON').trim().toUpperCase();

function normalize(text = '') {
  return String(text)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function detectWakeWord(text = '') {
  const normalized = normalize(text);
  if (!normalized) return { detected: false, wakeWord: WAKE_WORD, remainder: '' };
  const words = normalized.split(' ');
  const target = WAKE_WORD.split(' ').filter(Boolean);
  const matches = target.length > 0 && words.slice(0, target.length).join(' ') === target.join(' ');
  return {
    detected: matches,
    wakeWord: WAKE_WORD,
    remainder: matches ? words.slice(target.length).join(' ').trim() : normalized,
  };
}

function assertStrictWakeWord() {
  if (WAKE_WORD !== 'ULTRON') {
    throw new Error('ULTRON wake-word policy is locked to the exact single-word wake word: ULTRON.');
  }
}

module.exports = { WAKE_WORD, normalize, detectWakeWord, assertStrictWakeWord };