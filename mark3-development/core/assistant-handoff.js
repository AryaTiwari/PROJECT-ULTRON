const DEFAULT_HANDOFF = 'Anything else, Sir?';
const REPLY_WINDOW_MS = Math.max(7000, Number(process.env.ULTRON_M3_REPLY_WINDOW_MS || 7000));

function looksStructured(text) {
  const value = String(text || '');
  if (/```|^\s*[{[]/m.test(value)) return true;
  if (/^\s*(?:subject|to|from):/im.test(value)) return true;
  const lines = value.split(/\r?\n/).filter((line) => line.trim());
  const structured = lines.filter((line) => /^\s*(?:[-*•]|\d+[.)]|#{1,6}\s)/.test(line)).length;
  return lines.length >= 5 && structured >= 3;
}

function alreadyHandsOff(text) {
  const tail = String(text || '').trim().slice(-280);
  return /\b(?:next command|another command|anything else|need anything else|want me to|shall i|should i|do you want me to|what should i do next|what do you want me to do next|what would you like me to do next)\b/i.test(tail);
}

function hasActionableSuggestion(text) {
  const tail = String(text || '').trim().slice(-420);
  return /\b(?:next move|i(?:'d| would)\s+(?:do|prioriti[sz]e|focus|ship|fix|test|build|avoid)|my recommendation|my move|best move|priority now|do this next|focus on this next|leave .* for later)\b/i.test(tail);
}

function invitesImmediateReply(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  const tail = value.slice(-320);
  return /\?\s*$/.test(tail) || alreadyHandsOff(tail);
}

function responseDelivery(text) {
  const value = String(text || '').trim();
  const invitesReply = invitesImmediateReply(value);
  return {
    text: value,
    invitesReply,
    listenAfterResponseMs: invitesReply ? REPLY_WINDOW_MS : 0,
    hasSuggestion: hasActionableSuggestion(value),
    structured: looksStructured(value),
  };
}

// Kept only for explicit callers that intentionally want a command invitation.
// Normal Mark 3 responses should prefer a useful next move and should not append
// a generic question automatically.
function withCommandHandoff(text, handoff = DEFAULT_HANDOFF) {
  const value = String(text || '').trim();
  if (!value || looksStructured(value) || alreadyHandsOff(value) || /\?\s*$/.test(value)) return value;
  return `${value} ${handoff}`;
}

module.exports = {
  DEFAULT_HANDOFF,
  REPLY_WINDOW_MS,
  looksStructured,
  alreadyHandsOff,
  hasActionableSuggestion,
  invitesImmediateReply,
  responseDelivery,
  withCommandHandoff,
};
