function entityKey(text = '') {
  const normalized = String(text).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const match = normalized.match(/^my\s+(.+?)\s+is\s+(.+)$/);
  return match ? match[1].trim() : null;
}

function isConflict(candidate, existing) {
  if (!candidate || !existing || candidate.type !== existing.memory_type) return false;
  const a = entityKey(candidate.content);
  const b = entityKey(existing.content);
  return Boolean(a && b && a === b && candidate.content.toLowerCase() !== existing.content.toLowerCase());
}

function shouldSupersede(candidate, existing) {
  if (!isConflict(candidate, existing)) return false;
  const confidence = Number(candidate.confidence ?? 0);
  const existingConfidence = Number(existing.confidence ?? 0);
  const newer = confidence >= existingConfidence || Boolean(candidate.explicitCorrection);
  return newer;
}

module.exports = { entityKey, isConflict, shouldSupersede };
