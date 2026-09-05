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

const TOOLS = [
  {
    id: 'tavily', name: 'Tavily Search', category: 'research', priority: 1, implemented: true,
    env: ['TAVILY_API_KEY'], auth: 'api-key',
    free: '1,000 API credits/month; no card required',
    purpose: 'Second independent search/research provider when TinyFish fails or deeper corroboration is useful.',
    zeroCostSafe: true, autoUse: 'fallback-only',
  },
  {
    id: 'firecrawl', name: 'Firecrawl', category: 'web-extraction', priority: 2, implemented: true,
    env: ['FIRECRAWL_API_KEY'], auth: 'api-key',
    free: '1,000 credits/month; no card required',
    purpose: 'Reliable page extraction/crawling for sites direct HTTP cannot read.',
    zeroCostSafe: true, autoUse: 'fallback-only',
  },
  {
    id: 'cloudflare-r2', name: 'Cloudflare R2', category: 'storage', priority: 1, implemented: false,
    env: ['CLOUDFLARE_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'], auth: 's3-credentials',
    free: '10 GB-month + 1M Class A + 10M Class B operations/month; egress free',
    purpose: 'Public temporary media hosting for Instagram publishing and durable generated-artifact delivery.',
    zeroCostSafe: true, autoUse: 'explicit-feature',
  },
  {
    id: 'cloudflare-workers-ai', name: 'Cloudflare Workers AI', category: 'inference', priority: 2, implemented: false,
    env: ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'], auth: 'api-token',
    free: '10,000 Neurons/day on supported Free-plan models',
    purpose: 'Another cloud inference pool for lightweight reasoning/classification when primary free providers are constrained.',
    zeroCostSafe: true, autoUse: 'governed-fallback',
  },
  {
    id: 'youtube-data', name: 'YouTube Data API', category: 'creator-intelligence', priority: 1, implemented: false,
    env: ['YOUTUBE_API_KEY'], auth: 'api-key',
    free: 'Default quota; granular search/upload buckets plus 10,000 daily units for other endpoints',
    purpose: 'Study Shorts/video topics, channels, metadata and public performance signals for cross-platform creator intelligence.',
    zeroCostSafe: true, autoUse: 'research',
  },
  {
    id: 'resend', name: 'Resend', category: 'email', priority: 2, implemented: false,
    env: ['RESEND_API_KEY'], auth: 'api-key',
    free: '3,000 emails/month; 100/day',
    purpose: 'Transactional mail, founder notifications, lead follow-ups and CUP emails. Sending always remains approval-gated.',
    zeroCostSafe: true, autoUse: 'approval-required',
  },
  {
    id: 'telegram-bot', name: 'Telegram Bot API', category: 'remote-interface', priority: 2, implemented: false,
    env: ['TELEGRAM_BOT_TOKEN'], auth: 'bot-token',
    free: 'Bot API is free for developers',
    purpose: 'Remote Ultron command/notification surface from phone without keeping the web UI open.',
    zeroCostSafe: true, autoUse: 'approval-required-for-actions',
  },
  {
    id: 'alpha-vantage', name: 'Alpha Vantage', category: 'market-research', priority: 3, implemented: false,
    env: ['ALPHA_VANTAGE_API_KEY'], auth: 'api-key',
    free: '25 API requests/day for most datasets',
    purpose: 'Structured market data for research/backtesting and paper-trading analysis; never autonomous real-money execution.',
    zeroCostSafe: true, autoUse: 'research-paper-only',
  },
  {
    id: 'posthog', name: 'PostHog', category: 'product-analytics', priority: 2, implemented: false,
    env: ['POSTHOG_PROJECT_KEY', 'POSTHOG_HOST'], auth: 'project-key',
    free: 'Product analytics free tier includes 1M events/month',
    purpose: 'Measure Elevate OS funnels, feature usage and creator-product behavior so Ultron can make product decisions from real usage.',
    zeroCostSafe: true, autoUse: 'analytics',
  },
  {
    id: 'brave-search', name: 'Brave Search API', category: 'research', priority: 4, implemented: true,
    env: ['BRAVE_SEARCH_API_KEY'], auth: 'api-key',
    free: '$5 monthly credit (~1,000 Search requests), but card verification is required',
    purpose: 'Independent web index fallback when TinyFish/Tavily are unavailable.',
    zeroCostSafe: true, autoUse: 'fallback-only', caveat: 'Requires card verification despite $0 intended spend.',
  },
  {
    id: 'apify', name: 'Apify', category: 'automation-research', priority: 4, implemented: false,
    env: ['APIFY_API_TOKEN'], auth: 'api-token',
    free: '$5 platform credit/month; no card required',
    purpose: 'Specialized public-web Actors for research tasks that are difficult to implement directly. Do not use it to bypass platform access controls.',
    zeroCostSafe: true, autoUse: 'explicit-research',
  },
  {
    id: 'gmail-oauth', name: 'Gmail API', category: 'personal-operator', priority: 1, implemented: false,
    env: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'], auth: 'oauth',
    free: 'Standard API usage is no-additional-cost below current daily thresholds',
    purpose: 'Read/draft/send founder email with explicit action controls and inbox automation.',
    zeroCostSafe: true, autoUse: 'oauth-user-consent',
  },
  {
    id: 'calendar-oauth', name: 'Google Calendar API', category: 'personal-operator', priority: 1, implemented: false,
    env: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'], auth: 'oauth',
    free: 'Standard API usage is no-additional-cost below current daily thresholds',
    purpose: 'Real schedule awareness, meeting creation, reminders and proactive planning.',
    zeroCostSafe: true, autoUse: 'oauth-user-consent',
  },
  {
    id: 'gdelt', name: 'GDELT', category: 'news-intelligence', priority: 3, implemented: false,
    env: [], auth: 'none', free: 'Public APIs; no API key slot required',
    purpose: 'Global news/event context as a supplemental public research signal.',
    zeroCostSafe: true, autoUse: 'research',
  },
];

function state(tool) {
  const credentialsReady = !tool.env.length || tool.env.every((name) => configured(name));
  const missing = tool.env.filter((name) => !configured(name));
  const implemented = Boolean(tool.implemented);
  return { ...tool, credentialsReady, configured: credentialsReady, implemented, ready: implemented && credentialsReady, missing };
}
function status() {
  const rows = TOOLS.map(state);
  return {
    zeroCostOnly: true,
    ready: rows.filter((row) => row.ready),
    credentialed: rows.filter((row) => row.credentialsReady),
    implementedWaitingCredentials: rows.filter((row) => row.implemented && !row.credentialsReady).sort((a, b) => a.priority - b.priority),
    scaffolded: rows.filter((row) => !row.implemented),
    availableToAdd: rows.filter((row) => !row.credentialsReady).sort((a, b) => a.priority - b.priority),
    total: rows.length,
  };
}
function nextRecommendations(limit = 6) {
  const rows = TOOLS.map(state)
    .filter((row) => !row.ready)
    .sort((a, b) => a.priority - b.priority || Number(b.implemented) - Number(a.implemented));
  return rows.slice(0, Math.max(1, limit));
}
function byId(id) { const tool = TOOLS.find((row) => row.id === id); return tool ? state(tool) : null; }

module.exports = { TOOLS, configured, state, status, nextRecommendations, byId };
