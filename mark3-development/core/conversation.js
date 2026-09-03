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
  if (/^(?:yes|yeah|yep|no|nope|okay|ok|sure|do it|just\s+do\s+it|do\s+that(?:\s+now)?|run\s+it|execute\s+it|go\s+ahead(?:\s+and\s+do\s+it)?|continue|go on|finish(?:\s+it)?(?:\s+now)?|complete(?:\s+it)?|resume|retry|try again|proceed|carry on|list\s+(?:it|them|those)|show\s+(?:it|them|those)|give\s+(?:it|them|those)|this|that|it|same|exactly|why|how so)\b/i.test(value)) return true;
  if (/\bwhat\s+are\s+you\s+waiting\s+for\b[\s,;:!-]*(?:just\s+)?(?:do\s+it|go\s+ahead|start|proceed|execute)/i.test(value)) return true;
  if (/\b(?:come\s+on|go\s+on)[\s,;:!-]*(?:just\s+)?(?:do\s+it|continue|finish\s+it|execute)/i.test(value)) return true;
  return value.split(/\s+/).length <= 10 && /\b(?:this|that|it|they|them|those|these|above|previous|same|link|url|request|task|search|research|list)\b/i.test(value);
}

function isRecallQuery(text) {
  const value = String(text || '').trim();
  return /\b(?:remember|recall|recollect)\b.*\b(?:conversation|chat|discussion|talked|discussed|topic|thing)\b/i.test(value)
    || /\b(?:last|previous|earlier|old)\s+(?:conversation|chat|discussion)\b/i.test(value)
    || /\bwe\s+(?:talked|spoke|discussed|chatted)\s+about\b/i.test(value)
    || /\b(?:conversation|chat|discussion)\s+(?:about|regarding|where)\b/i.test(value);
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

function recallQueryText(query) {
  return String(query || '')
    .replace(/\b(?:please|can you|could you|do you|remember|recall|recollect|the|my|our|last|previous|earlier|old|conversation|chat|discussion|we|talked|spoke|discussed|chatted|regarding|about|where|topic|thing)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim() || String(query || '').trim();
}

function searchHistory(query, options = {}) {
  const rows = readJsonl(config.conversationPath)
    .filter((item) => item && ['user', 'assistant'].includes(item.role) && String(item.content || '').trim());
  if (!rows.length) return [];

  const focused = recallQueryText(query);
  const queryNumbers = [...String(query || '').matchAll(/\b\d+[kKmM]?\b/g)].map((match) => match[0].toLowerCase());
  const scored = rows.map((row, index) => {
    const content = String(row.content || '');
    const lexical = Math.max(overlap(focused, content), overlap(query, content) * 0.78);
    const lower = content.toLowerCase();
    const numberBoost = queryNumbers.length && queryNumbers.some((value) => lower.includes(value)) ? 0.12 : 0;
    return { index, score: lexical + numberBoost };
  })
    .filter((row) => row.score >= 0.16)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(6, Number(options.matches || 4))));

  if (!scored.length) return [];
  const indices = new Set();
  for (const match of scored) {
    for (let i = Math.max(0, match.index - 2); i <= Math.min(rows.length - 1, match.index + 3); i += 1) indices.add(i);
  }

  const limit = Math.max(4, Math.min(16, Number(options.limit || 12)));
  return [...indices]
    .sort((a, b) => a - b)
    .map((index) => rows[index])
    .slice(-limit)
    .map((m) => ({ role: m.role, content: m.content, at: m.at, model: m.model || null, recalled: true }));
}

function uniqueContext(items) {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).filter((item) => {
    const key = `${item.role}|${item.at || ''}|${String(item.content || '').trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function contextFor(query, suppliedHistory = null) {
  const value = String(query || '').trim();
  if (!value || isGreeting(value)) return [];

  const supplied = normalizeHistory(suppliedHistory);
  const persisted = readJsonl(config.conversationPath)
    .filter((item) => item && ['user', 'assistant'].includes(item.role) && String(item.content || '').trim());
  const session = currentSession(persisted).map((m) => ({ role: m.role, content: m.content, at: m.at, model: m.model || null }));
  const source = supplied.length ? supplied : session;

  if (isRecallQuery(value)) {
    const recalled = searchHistory(value, { limit: 12, matches: 4 });
    if (recalled.length) return uniqueContext([...recalled, ...source.slice(-4)]).slice(-14);
  }

  if (!source.length) return [];
  if (isBareUrl(value)) return source.slice(-4);
  if (isContinuation(value)) {
    const tail = source.slice(-8);
    const anchor = [...source].reverse().find((item) => item.role === 'user' && !isContinuation(item.content));
    return uniqueContext(anchor ? [anchor, ...tail] : tail).slice(-9);
  }

  const tail = source.slice(-8);
  const relevant = tail.some((item) => overlap(value, item.content) >= 0.16);
  if (!relevant) return [];
  return tail.slice(-6);
}

module.exports = { append, recent, contextFor, searchHistory, isRecallQuery, isGreeting, isBareUrl, isContinuation, overlap };
