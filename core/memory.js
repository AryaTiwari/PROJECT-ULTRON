function normalizeMemoryCandidate(candidate = {}) {
  return {
    type: String(candidate.type || 'fact'),
    content: String(candidate.content || '').trim(),
    importance: Number.isFinite(candidate.importance) ? candidate.importance : 0.5,
    confidence: Number.isFinite(candidate.confidence) ? candidate.confidence : 0.8,
    source: candidate.source || 'conversation',
  };
}

function normalizeForComparison(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeDuplicate(candidate, existing = []) {
  const normalized = normalizeForComparison(candidate.content);
  if (!normalized) return false;

  return existing.some(item => {
    const other = normalizeForComparison(item?.content);
    return other === normalized || (other && normalized.length > 24 && (other.includes(normalized) || normalized.includes(other)));
  });
}

module.exports = {
  normalizeMemoryCandidate,
  normalizeForComparison,
  looksLikeDuplicate,
};
