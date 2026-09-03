const DEFAULT_HANDOFF = "What's your next command?";

function looksStructured(text) {
  const value = String(text || '');
  if (/```|^\s*[{[]/m.test(value)) return true;
  if (/^\s*(?:subject|to|from):/im.test(value)) return true;
  const lines = value.split(/\r?\n/).filter((line) => line.trim());
  const structured = lines.filter((line) => /^\s*(?:[-*•]|\d+[.)]|#{1,6}\s)/.test(line)).length;
  return lines.length >= 5 && structured >= 3;
}

function alreadyHandsOff(text) {
  const tail = String(text || '').trim().slice(-220);
  return /\?\s*$/.test(tail)
    || /\b(?:next command|what should i do next|what do you want me to do next|what would you like me to do next|anything else|want me to|shall i|should i)\b/i.test(tail);
}

function withCommandHandoff(text, handoff = DEFAULT_HANDOFF) {
  const value = String(text || '').trim();
  if (!value || looksStructured(value) || alreadyHandsOff(value)) return value;
  return `${value} ${handoff}`;
}

module.exports = { DEFAULT_HANDOFF, looksStructured, alreadyHandsOff, withCommandHandoff };
