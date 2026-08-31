const crypto = require('crypto');
const config = require('./config');
const { readJson, writeJsonAtomic, appendJsonl } = require('./persistence');

const TYPES = new Set(['semantic', 'episodic', 'working', 'strategic', 'preference', 'commitment', 'decision']);

function normalize(text) {
  return String(text || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function tokens(text) { return new Set(normalize(text).split(' ').filter(Boolean)); }
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

function retrieve(query, options = {}) {
  const limit = Number(options.limit || config.maxContextItems);
  const items = load();
  const ranked = items.map(item => {
    const recency = Math.max(0, 1 - ((Date.now() - Date.parse(item.lastUsedAt || item.updatedAt || item.createdAt)) / 1000 / 86400 / 90));
    const score = similarity(query, item.normalized || item.content) * 0.7 + Number(item.importance || 0) * 0.2 + recency * 0.1;
    return { item, score };
  }).filter(row => row.score > 0.1).sort((a, b) => b.score - a.score).slice(0, limit);
  const usedAt = new Date().toISOString();
  for (const row of ranked) row.item.lastUsedAt = usedAt;
  save(items);
  return ranked.map(row => ({ ...row.item, retrievalScore: Number(row.score.toFixed(4)) }));
}

function snapshot() {
  const items = load();
  return { total: items.length, byType: Object.fromEntries([...TYPES].map(type => [type, items.filter(item => item.type === type).length])) };
}

module.exports = { normalize, similarity, load, save, remember, retrieve, findSimilar, snapshot };
