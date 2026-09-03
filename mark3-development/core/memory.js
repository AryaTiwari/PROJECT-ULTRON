const crypto = require('crypto');
const config = require('./config');
const { readJson, writeJsonAtomic, appendJsonl } = require('./persistence');

const TYPES = new Set([
  'semantic', 'episodic', 'working', 'strategic', 'preference', 'commitment', 'decision',
  'person', 'project', 'goal', 'task', 'event', 'conversation_summary',
]);
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
    .filter((item) => item.status !== 'superseded')
    .map(item => ({ item, score: item.normalized ? similarity(normalized, item.normalized) : similarity(normalized, item.content) }))
    .filter(row => row.score >= 0.72)
    .sort((a, b) => b.score - a.score);
}

function memoryKey(input = {}) {
  const explicit = normalize(input.key || '');
  if (explicit) return explicit;
  const entity = normalize(input.entity || input.subject || '');
  const relation = normalize(input.relation || '');
  return entity && relation ? `${entity}:${relation}` : null;
}

function remember(input = {}) {
  const content = String(input.content || '').trim();
  if (!content) throw new Error('Memory content is required.');
  if (OPERATIONAL_MEMORY.test(content)) return { action: 'IGNORED_OPERATIONAL', memory: null, score: 0 };
  const type = TYPES.has(input.type) ? input.type : 'semantic';
  const items = load();
  const key = memoryKey(input);
  const now = new Date().toISOString();

  if (key) {
    const existing = items.find((item) => item.status !== 'superseded' && normalize(item.key || '') === key);
    if (existing) {
      if (normalize(existing.content) === normalize(content)) {
        existing.updatedAt = now;
        existing.lastUsedAt = now;
        save(items);
        return { action: 'DUPLICATE', memory: existing, score: 1 };
      }
      existing.previousContents = [...(Array.isArray(existing.previousContents) ? existing.previousContents : []), existing.content].slice(-5);
      existing.content = content;
      existing.normalized = normalize(content);
      existing.type = type;
      existing.confidence = Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : existing.confidence;
      existing.importance = Number.isFinite(Number(input.importance)) ? Number(input.importance) : existing.importance;
      existing.source = input.source || existing.source;
      existing.project = input.project ?? existing.project ?? null;
      existing.tags = Array.isArray(input.tags) ? input.tags : existing.tags || [];
      existing.entity = input.entity || input.subject || existing.entity || null;
      existing.relation = input.relation || existing.relation || null;
      existing.object = input.object ?? existing.object ?? null;
      existing.status = 'active';
      existing.revision = Number(existing.revision || 1) + 1;
      existing.updatedAt = now;
      existing.lastUsedAt = now;
      save(items);
      appendJsonl(config.eventsPath, { type: 'memory_updated', memoryId: existing.id, key, at: now });
      return { action: 'UPDATED', memory: existing, score: 1 };
    }
  }

  const matches = findSimilar(content, items);
  if (matches[0] && matches[0].score >= 0.92) {
    matches[0].item.updatedAt = now;
    matches[0].item.lastUsedAt = now;
    save(items);
    return { action: 'DUPLICATE', memory: matches[0].item, score: matches[0].score };
  }

  const memory = {
    id: crypto.randomUUID(), type, content, normalized: normalize(content), key,
    entity: input.entity || input.subject || null,
    relation: input.relation || null,
    object: input.object ?? null,
    status: 'active', revision: 1,
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

function supersede(id, replacementId = null) {
  const items = load();
  const item = items.find((row) => row.id === id);
  if (!item) return null;
  item.status = 'superseded';
  item.supersededBy = replacementId;
  item.updatedAt = new Date().toISOString();
  save(items);
  return item;
}

function isContextFreeQuery(query) {
  return /^(?:hey+|hi+|hello+|yo+|sup|what'?s up|good\s+(?:morning|afternoon|evening))(?:\s+(?:there|ultron|bro|buddy))?[!.?\s]*$/i.test(String(query || '').trim());
}

function tagOrProjectMatch(query, item) {
  const q = normalize(query);
  if (!q) return false;
  const project = normalize(item.project || '');
  if (project && (q.includes(project) || project.includes(q))) return true;
  const entity = normalize(item.entity || '');
  if (entity && (q.includes(entity) || entity.includes(q))) return true;
  return (item.tags || []).some((tag) => {
    const t = normalize(tag);
    return t && (q.includes(t) || t.includes(q));
  });
}

function retrieve(query, options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit || config.maxContextItems), 8));
  if (isContextFreeQuery(query)) return [];

  const items = load();
  const wantedTypes = Array.isArray(options.types) ? new Set(options.types) : null;
  const ranked = items.map(item => {
    if (item.status === 'superseded' || OPERATIONAL_MEMORY.test(String(item.content || ''))) return null;
    if (wantedTypes && !wantedTypes.has(item.type)) return null;
    const lexical = similarity(query, item.normalized || item.content);
    const anchored = tagOrProjectMatch(query, item);
    if (lexical < 0.055 && !anchored) return null;
    const recency = Math.max(0, 1 - ((Date.now() - Date.parse(item.lastUsedAt || item.updatedAt || item.createdAt)) / 1000 / 86400 / 90));
    const score = lexical * 0.76 + Number(item.importance || 0) * 0.12 + recency * 0.06 + (anchored ? 0.14 : 0);
    return { item, score, lexical };
  }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, limit);

  if (!ranked.length) return [];
  const usedAt = new Date().toISOString();
  for (const row of ranked) row.item.lastUsedAt = usedAt;
  save(items);
  return ranked.map(row => ({ ...row.item, retrievalScore: Number(row.score.toFixed(4)), lexicalScore: Number(row.lexical.toFixed(4)) }));
}

function snapshot() {
  const items = load().filter((item) => item.status !== 'superseded');
  return {
    total: items.length,
    byType: Object.fromEntries([...TYPES].map(type => [type, items.filter(item => item.type === type).length])),
    keyed: items.filter((item) => item.key).length,
  };
}

module.exports = { TYPES, normalize, similarity, load, save, remember, retrieve, findSimilar, supersede, snapshot };
