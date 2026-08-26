const { normalizeForComparison, normalizeMemoryCandidate, looksLikeDuplicate } = require('./memory');

function getConfig() {
  return {
    url: String(process.env.SUPABASE_URL || '').replace(/\/$/, ''),
    key: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '',
  };
}

async function supabaseRequest(table, options = {}) {
  const { url, key } = getConfig();
  if (!url || !key) return null;

  const response = await fetch(`${url}/rest/v1/${table}`, {
    method: options.method || 'GET',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=representation',
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  if (!response.ok) throw new Error(`Supabase ${table} returned HTTP ${response.status}: ${raw.slice(0, 500)}`);
  return data;
}

async function findSimilarMemory(candidate) {
  const normalized = normalizeForComparison(candidate.content);
  if (!normalized) return null;

  const data = await supabaseRequest('memories', {
    headers: { Accept: 'application/json' },
  });
  if (!Array.isArray(data)) return null;
  return data.find(item => {
    if (item.active === false) return false;
    return looksLikeDuplicate(candidate, [item]);
  }) || null;
}

async function saveMemory(candidate) {
  const normalized = normalizeMemoryCandidate(candidate);
  if (!normalized.content) return { stored: false, reason: 'empty' };

  const duplicate = await findSimilarMemory(normalized);
  if (duplicate) {
    return { stored: false, duplicate: true, existing: duplicate };
  }

  const inserted = await supabaseRequest('memories', {
    method: 'POST',
    body: [{
      memory_type: normalized.type,
      content: normalized.content,
      normalized_content: normalizeForComparison(normalized.content),
      importance: normalized.importance,
      confidence: normalized.confidence,
      source: normalized.source,
    }],
  });

  return { stored: true, memory: Array.isArray(inserted) ? inserted[0] : inserted };
}

async function saveConversationMessage(conversationId, message) {
  if (!conversationId || !message?.role || !message?.content) return null;
  return supabaseRequest('conversation_messages', {
    method: 'POST',
    body: [{
      conversation_id: conversationId,
      role: message.role,
      content: message.content,
      model: message.model || null,
      metadata: message.metadata || {},
    }],
  });
}

module.exports = {
  getConfig,
  saveMemory,
  saveConversationMessage,
};
