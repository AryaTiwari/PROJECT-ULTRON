const crypto = require('crypto');
const config = require('./config');
const { readJson, writeJsonAtomic, appendJsonl } = require('./persistence');

const TYPES = new Set(['semantic', 'episodic', 'working', 'strategic', 'preference', 'commitment', 'decision']);
const OPERATIONAL_MEMORY = /^completed\s+\w+\s+task\s+using\s+/i;

function normalize(text) {
  return String(text || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function tokens(text) { return new Set(normalize(text).split(' ').filter((token) => token.length > 1)); }
function similarity(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let intersection = 0; for (const item of A) if (B.has(item)) intersection++;
  return intersection / (A.size + B.size - intersection);
}

function load() { return readJson(config.memoryPath, []); }
function save(items) { writeJsonAtomic(config.memoryPath, items); }

function findSimilar(content, items = load()) {
  const normalized = normalize(content);
  return items
    .map(item => ({ item, score: item.normalized ? similarity(normalized, item.normalized) : similarity(normalized, item.content) }))
    .filter(row => row.score >= 0.72)
    .sort((a, b) => b.score - a.score);
}

function remember(input = {}) {
  const content = String(input.content || '').trim();
  if (!content) throw new Error('Memory content is required.');
  if (OPERATIONAL_MEMORY.test(content)) return { action: 'IGNORED_OPERATIONAL', memory: null, score: 0 };
  const type = TYPES.has(input.type) ? input.type : 'semantic';
  const items = load();
  const matches = findSimilar(content, items);
  if (matches[0] && matches[0].score >= 0.92) {
    matches[0].item.updatedAt = new Date().toISOString();
    matches[0].item.lastUsedAt = matches[0].item.updatedAt;
    save(items);
    return { action: 'DUPLICATE', memory: matches[0].item, score: matches[0].score };
  }
  const now = new Date().toISOString();
  const memory = {
    id: crypto.randomUUID(), type, content, normalized: normalize(content),
    confidence: Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : 0.85,
    importance: Number.isFinite(Number(input.importance)) ? Number(input.importance) : 0.6,
    source: input.source || 'conversation', project: input.project || null,
    tags: Array.isArray(input.tags) ? input.tags : [],
    createdAt: now, updatedAt: now, lastUsedAt: now,
  };
  items.push(memory);
  save(items);
  appendJsonl(config.eventsPath, { type: 'memory_saved', memoryId: memory.id, at: now });
  return { action: 'SAVED', memory };
}

function isContextFreeQuery(query) {
  return /^(?:hey+|hi+|hello+|yo+|sup|what'?s up|good\s+(?:morning|afternoon|evening))(?:\s+(?:there|ultron|bro|buddy))?[!.?\s]*$/i.test(String(query || '').trim());
}

function tagOrProjectMatch(query, item) {
  const q = normalize(query);
  if (!q) return false;
  const project = normalize(item.project || '');
  if (project && (q.includes(project) || project.includes(q))) return true;
  return (item.tags || []).some((tag) => {
    const t = normalize(tag);
    return t && (q.includes(t) || t.includes(q));
  });
}

function retrieve(query, options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit || config.maxContextItems), 8));
  if (isContextFreeQuery(query)) return [];

  const items = load();
  const ranked = items.map(item => {
    if (OPERATIONAL_MEMORY.test(String(item.content || ''))) return null;
    const lexical = similarity(query, item.normalized || item.content);
    const anchored = tagOrProjectMatch(query, item);
    // Recency/importance may rank a relevant memory, but can never make an
    // unrelated memory relevant on their own.
    if (lexical < 0.055 && !anchored) return null;
    const recency = Math.max(0, 1 - ((Date.now() - Date.parse(item.lastUsedAt || item.updatedAt || item.createdAt)) / 1000 / 86400 / 90));
    const score = lexical * 0.78 + Number(item.importance || 0) * 0.12 + recency * 0.06 + (anchored ? 0.12 : 0);
    return { item, score, lexical };
  }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, limit);

  if (!ranked.length) return [];
  const usedAt = new Date().toISOString();
  for (const row of ranked) row.item.lastUsedAt = usedAt;
  save(items);
  return ranked.map(row => ({ ...row.item, retrievalScore: Number(row.score.toFixed(4)), lexicalScore: Number(row.lexical.toFixed(4)) }));
}

function snapshot() {
  const items = load();
  return { total: items.length, byType: Object.fromEntries([...TYPES].map(type => [type, items.filter(item => item.type === type).length])) };
}

module.exports = { normalize, similarity, load, save, remember, retrieve, findSimilar, snapshot };
