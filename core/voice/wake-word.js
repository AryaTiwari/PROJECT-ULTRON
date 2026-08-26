const WAKE_WORD = 'ULTRON';

function normalize(text = '') {
  return String(text)
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function detect(text = '') {
  const normalized = normalize(text);
  if (!normalized) return false;
  return normalized === WAKE_WORD || normalized.startsWith(`${WAKE_WORD} `);
}

function extractCommand(text = '') {
  const normalized = normalize(text);
  if (!detect(normalized)) return '';
  return normalized.slice(WAKE_WORD.length).trim();
}

module.exports = { WAKE_WORD, normalize, detect, extractCommand };
