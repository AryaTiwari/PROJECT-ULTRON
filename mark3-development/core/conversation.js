const config = require('./config');
const { appendJsonl, readJsonl } = require('./persistence');

const SESSION_GAP_MS = Math.max(5 * 60 * 1000, Number(process.env.ULTRON_M3_SESSION_GAP_MS || 45 * 60 * 1000));

function append(role, content, meta = {}) {
  appendJsonl(config.conversationPath, {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    content: String(content || ''),
    ...meta,
    at: new Date().toISOString(),
  });
}

function recent(limit = config.maxConversationItems) {
  return readJsonl(config.conversationPath)
    .slice(-limit)
    .map((m) => ({ role: m.role, content: m.content, at: m.at, model: m.model || null }));
}

function tokens(text) {
  return new Set(String(text || '')
    .toLowerCase()
    .replace(/https?:\/\//g, ' ')
    .replace(/www\./g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2));
}

function overlap(a, b) {
  const A = tokens(a); const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const token of A) if (B.has(token)) shared += 1;
  return shared / Math.max(1, Math.min(A.size, B.size));
}

function isGreeting(text) {
  return /^(?:hey+|hi+|hello+|yo+|sup|what'?s up|good\s+(?:morning|afternoon|evening))(?:\s+(?:there|ultron|bro|buddy))?[!.?\s]*$/i.test(String(text || '').trim());
}

function isBareUrl(text) {
  return /^(?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?:[\/?#][^\s]*)?$/i.test(String(text || '').trim());
}

function isContinuation(text) {
  const value = String(text || '').trim();
  if (isBareUrl(value)) return true;
  if (/^(?:yes|yeah|yep|no|nope|okay|ok|sure|do it|continue|go on|this|that|it|same|exactly|why|how so)\b/i.test(value)) return true;
  return value.split(/\s+/).length <= 8 && /\b(?:this|that|it|they|them|those|these|above|previous|same|link|url)\b/i.test(value);
}

function currentSession(rows) {
  if (!rows.length) return [];
  let start = rows.length - 1;
  for (let i = rows.length - 1; i > 0; i -= 1) {
    const newer = Date.parse(rows[i].at || '');
    const older = Date.parse(rows[i - 1].at || '');
    if (Number.isFinite(newer) && Number.isFinite(older) && newer - older > SESSION_GAP_MS) break;
    start = i - 1;
  }
  return rows.slice(start);
}

function normalizeHistory(history) {
  return (Array.isArray(history) ? history : [])
    .filter((item) => item && ['user', 'assistant'].includes(item.role) && String(item.content || '').trim())
    .map((item) => ({ role: item.role, content: String(item.content || ''), at: item.at || null, model: item.model || null }));
}

function contextFor(query, suppliedHistory = null) {
  const value = String(query || '').trim();
  if (!value || isGreeting(value)) return [];

  const supplied = normalizeHistory(suppliedHistory);
  const source = supplied.length ? supplied : currentSession(recent(config.maxConversationItems));
  if (!source.length) return [];

  if (isBareUrl(value)) return source.slice(-4);
  if (isContinuation(value)) return source.slice(-6);

  const tail = source.slice(-8);
  const relevant = tail.some((item) => overlap(value, item.content) >= 0.16);
  if (!relevant) return [];
  return tail.slice(-6);
}

module.exports = { append, recent, contextFor, isGreeting, isBareUrl, isContinuation, overlap };
