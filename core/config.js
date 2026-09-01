const path = require('path');

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function normalizeBaseUrl(value) {
  return String(value || '').replace(/\/$/, '');
}

const omniRouteBase = normalizeBaseUrl(process.env.OMNIROUTE_BASE_URL || 'http://127.0.0.1:20128/v1');
const omniRouteEndpointKey = process.env.OMNIROUTE_ENDPOINT_KEY || process.env.OMNIROUTE_API_KEY || process.env.ULTRON_OMNIROUTE_API_KEY || '';

const config = {
  name: process.env.ULTRON_NAME || 'ULTRON',
  host: process.env.ULTRON_CORE_HOST || '127.0.0.1',
  port: numberEnv('ULTRON_CORE_PORT', 8787),
  personalityFile: process.env.ULTRON_PERSONALITY_FILE || path.join(__dirname, 'personality', 'default.json'),
  memoryFile: process.env.ULTRON_LOCAL_MEMORY_FILE || path.join(process.cwd(), '.ultron', 'memory.json'),
  conversationFile: process.env.ULTRON_LOCAL_CONVERSATION_FILE || path.join(process.cwd(), '.ultron', 'conversations.json'),
  recentMessageLimit: numberEnv('ULTRON_RECENT_MESSAGE_LIMIT', 12),
  memorySimilarityThreshold: numberEnv('ULTRON_MEMORY_SIMILARITY_THRESHOLD', 0.82),
  memoryNearDuplicateThreshold: numberEnv('ULTRON_MEMORY_NEAR_DUPLICATE_THRESHOLD', 0.72),
  router: {
    baseUrl: omniRouteBase,
    endpoint: process.env.OMNIROUTE_CHAT_URL || `${omniRouteBase}/chat/completions`,
    apiKey: omniRouteEndpointKey,
    model: process.env.ULTRON_MODEL || 'auto',
    timeoutMs: numberEnv('ULTRON_MODEL_TIMEOUT_MS', 120000),
  },
  supabase: {
    url: process.env.SUPABASE_URL || '',
    key: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '',
  },
};

module.exports = { config };
