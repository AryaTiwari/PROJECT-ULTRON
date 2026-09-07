const fs = require('fs');
const path = require('path');
const config = require('./config');

function hasEnv(...names) {
  return names.some((name) => Boolean(String(process.env[name] || '').trim()));
}
function envFileHas(...names) {
  try {
    const file = path.resolve(config.projectRoot, '.env');
    if (!fs.existsSync(file)) return false;
    const text = fs.readFileSync(file, 'utf8');
    return names.some((name) => new RegExp(`^\\s*${name}\\s*=\\s*.+$`, 'm').test(text));
  } catch { return false; }
}
function configured(...names) { return hasEnv(...names) || envFileHas(...names); }

// Keep this registry deliberately small. It represents integrations the founder has
// actually enrolled, plus Telegram which is intentionally installed-but-dormant.
// Future ideas belong in planning/Forge recipes, not in runtime health noise.
const TOOLS = [
  {
    id: 'pexels', name: 'Pexels', category: 'reel-media', priority: 1, implemented: true, enrolled: true,
    env: ['PEXELS_API_KEY'], auth: 'api-key',
    purpose: 'Primary free stock-video source for Reel Factory.', zeroCostSafe: true, autoUse: 'reel-source',
  },
  {
    id: 'jina-reader', name: 'Jina Reader', category: 'web-extraction', priority: 1, implemented: true, enrolled: true,
    env: [], auth: 'none',
    purpose: 'No-key fallback that converts difficult public URLs into LLM-friendly Markdown.', zeroCostSafe: true, autoUse: 'fallback-only',
  },
  {
    id: 'tavily', name: 'Tavily Search', category: 'research', priority: 1, implemented: true, enrolled: true,
    env: ['TAVILY_API_KEY'], auth: 'api-key',
    purpose: 'Independent search/research fallback when the primary research route fails or needs corroboration.', zeroCostSafe: true, autoUse: 'fallback-only',
  },
  {
    id: 'firecrawl', name: 'Firecrawl', category: 'web-extraction', priority: 1, implemented: true, enrolled: true,
    env: ['FIRECRAWL_API_KEY'], auth: 'api-key',
    purpose: 'Hard-page extraction fallback when direct HTTP and Jina cannot read a page reliably.', zeroCostSafe: true, autoUse: 'fallback-only',
  },
  {
    id: 'buffer', name: 'Buffer API', category: 'social-publishing', priority: 1, implemented: true, enrolled: true,
    env: ['BUFFER_API_KEY'], auth: 'api-key',
    purpose: 'Connected-channel verification and safe social video-post dry-runs. Live writes remain approval-gated.', zeroCostSafe: true, autoUse: 'explicit-feature',
  },
  {
    id: 'telegram-bot', name: 'Telegram Remote', category: 'remote-interface', priority: 3, implemented: true, enrolled: false,
    env: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_CHAT_ID'], auth: 'bot-token + private-chat allowlist',
    purpose: 'Optional secure phone command surface. Code is retained, but enrollment/polling is intentionally paused.', zeroCostSafe: true, autoUse: 'dormant-until-enrolled',
  },
];

function state(tool) {
  const credentialsReady = !tool.env.length || tool.env.every((name) => configured(name));
  const missing = tool.env.filter((name) => !configured(name));
  const implemented = Boolean(tool.implemented);
  const enrolled = tool.enrolled !== false;
  return {
    ...tool,
    enrolled,
    credentialsReady,
    configured: credentialsReady,
    implemented,
    ready: implemented && credentialsReady && enrolled,
    dormant: implemented && !enrolled,
    missing,
  };
}
function status() {
  const rows = TOOLS.map(state);
  return {
    zeroCostOnly: true,
    ready: rows.filter((row) => row.ready),
    credentialed: rows.filter((row) => row.credentialsReady),
    implementedWaitingCredentials: rows.filter((row) => row.implemented && row.enrolled && !row.credentialsReady).sort((a, b) => a.priority - b.priority),
    dormant: rows.filter((row) => row.dormant),
    scaffolded: rows.filter((row) => !row.implemented),
    availableToAdd: rows.filter((row) => row.enrolled && !row.credentialsReady).sort((a, b) => a.priority - b.priority),
    total: rows.length,
  };
}
function nextRecommendations(limit = 6) {
  const rows = TOOLS.map(state)
    .filter((row) => row.enrolled && !row.ready)
    .sort((a, b) => a.priority - b.priority || Number(b.implemented) - Number(a.implemented));
  return rows.slice(0, Math.max(1, limit));
}
function byId(id) { const tool = TOOLS.find((row) => row.id === id); return tool ? state(tool) : null; }

module.exports = { TOOLS, configured, state, status, nextRecommendations, byId };
