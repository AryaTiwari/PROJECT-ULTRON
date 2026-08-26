const { config } = require('../config');

function available() { return Boolean(config.supabase.url && config.supabase.key); }

function headers() {
  return { apikey: config.supabase.key, Authorization: `Bearer ${config.supabase.key}`, 'Content-Type': 'application/json' };
}

async function request(table, options = {}) {
  if (!available()) return null;
  const response = await fetch(`${config.supabase.url.replace(/\/$/, '')}/rest/v1/${table}`, {
    ...options,
    headers: { ...headers(), ...(options.headers || {}) },
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) throw new Error(`Supabase ${table} returned HTTP ${response.status}: ${text.slice(0, 500)}`);
  return data;
}

async function listMemories(limit = 100) { return request(`memories?active=eq.true&order=updated_at.desc&limit=${limit}`, { method: 'GET' }) || []; }
async function insertMemory(memory) {
  const result = await request('memories', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify([memory]) });
  return Array.isArray(result) ? result[0] : result;
}
async function updateMemory(id, patch) {
  const result = await request(`memories?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch) });
  return Array.isArray(result) ? result[0] : result;
}
async function insertConversationMessage(message) {
  const result = await request('conversation_messages', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify([message]) });
  return Array.isArray(result) ? result[0] : result;
}
async function insertModelPerformance(event) {
  const result = await request('model_performance', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify([event]) });
  return Array.isArray(result) ? result[0] : result;
}
async function insertSystemEvent(event) {
  const result = await request('system_events', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify([event]) });
  return Array.isArray(result) ? result[0] : result;
}

module.exports = { available, listMemories, insertMemory, updateMemory, insertConversationMessage, insertModelPerformance, insertSystemEvent };
