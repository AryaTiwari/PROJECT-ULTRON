const crypto = require('crypto');
const { config } = require('../config');

function normalize(text = '') {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(text) {
  return new Set(normalize(text).split(' ').filter(token => token.length > 1));
}

function lexicalSimilarity(a, b) {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let overlap = 0;
  for (const token of A) if (B.has(token)) overlap += 1;
  return overlap / Math.sqrt(A.size * B.size);
}

function hash(text) {
  return crypto.createHash('sha256').update(normalize(text)).digest('hex');
}

async function embeddingSimilarity(candidate, existing, embedder) {
  if (typeof embedder !== 'function') return null;
  try {
    const [a, b] = await Promise.all([embedder(candidate), embedder(existing)]);
    if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return null;
    let dot = 0; let normA = 0; let normB = 0;
    for (let i = 0; i < a.length; i += 1) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : null;
  } catch {
    return null;
  }
}

async function judge(candidate, existingMemories = [], embedder = null) {
  const content = String(candidate?.content || '').trim();
  if (!content) return { decision: 'IGNORE', reason: 'empty', score: 0 };

  const normalized = normalize(content);
  const contentHash = hash(content);
  let best = null;

  for (const memory of existingMemories.filter(item => item?.active !== false)) {
    if (memory.content_hash && memory.content_hash === contentHash) {
      return { decision: 'IGNORE', reason: 'exact_duplicate', score: 1, matched: memory };
    }
    if (normalize(memory.content) === normalized) {
      return { decision: 'IGNORE', reason: 'normalized_duplicate', score: 1, matched: memory };
    }
    const lexical = lexicalSimilarity(content, memory.content);
    if (!best || lexical > best.score) best = { score: lexical, memory, method: 'lexical' };
  }

  if (best && best.score >= config.memorySimilarityThreshold) {
    return { decision: 'IGNORE', reason: 'strong_near_duplicate', score: best.score, matched: best.memory, method: best.method };
  }

  if (best && best.score >= config.memoryNearDuplicateThreshold) {
    return { decision: 'REVIEW', reason: 'possible_near_duplicate', score: best.score, matched: best.memory, method: best.method };
  }

  if (embedder && existingMemories.length) {
    let semanticBest = null;
    for (const memory of existingMemories.filter(item => item?.active !== false)) {
      const score = await embeddingSimilarity(content, memory.content, embedder);
      if (score !== null && (!semanticBest || score > semanticBest.score)) {
        semanticBest = { score, memory, method: 'embedding' };
      }
    }
    if (semanticBest && semanticBest.score >= config.memorySimilarityThreshold) {
      return { decision: 'IGNORE', reason: 'semantic_duplicate', score: semanticBest.score, matched: semanticBest.memory, method: 'embedding' };
    }
    if (semanticBest && semanticBest.score >= config.memoryNearDuplicateThreshold) {
      return { decision: 'REVIEW', reason: 'semantic_near_duplicate', score: semanticBest.score, matched: semanticBest.memory, method: 'embedding' };
    }
  }

  return { decision: 'SAVE', reason: 'new_memory', score: best?.score || 0, normalized, content_hash: contentHash };
}

module.exports = { normalize, lexicalSimilarity, judge };
