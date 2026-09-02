const config = require('./config');
const { readJson, writeJsonAtomic } = require('./persistence');
const { load: loadCredentials } = require('../../core/credentials/local-store');

const PROVIDERS = {
  gemini: { tier: 'api', priority: 10, credentials: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] },
  groq: { tier: 'api', priority: 20, credentials: ['GROQ_API_KEY'] },
  deepseek: { tier: 'api', priority: 30, credentials: ['DEEPSEEK_API_KEY'] },
  mistral: { tier: 'api', priority: 40, credentials: ['MISTRAL_API_KEY'] },
  qwen: { tier: 'api', priority: 50, credentials: ['QWEN_API_KEY', 'DASHSCOPE_API_KEY'] },
  openai: { tier: 'api', priority: 60, credentials: ['OPENAI_API_KEY'] },
  anthropic: { tier: 'api', priority: 70, credentials: ['ANTHROPIC_API_KEY'] },
  xai: { tier: 'api', priority: 80, credentials: ['XAI_API_KEY'] },
  vertex: { tier: 'api', priority: 90, credentials: ['VERTEX_API_KEY', 'GOOGLE_API_KEY'] },
  zenmux: { tier: 'api', priority: 100, credentials: ['ZENMUX_API_KEY'] },
  bytez: { tier: 'api', priority: 110, credentials: ['BYTEZ_API_KEY'] },
  pollinations: { tier: 'public', priority: 200, credentials: ['POLLINATIONS_API_KEY'], publicFallback: true },
  'cloudflare-playground': { tier: 'experimental', priority: 900 },
  'duckduckgo-web': { tier: 'experimental', priority: 910 },
  'felo-web': { tier: 'experimental', priority: 920 },
  chipotle: { tier: 'experimental', priority: 930 },
  theoldllm: { tier: 'experimental', priority: 940 },
  uncloseai: { tier: 'experimental', priority: 950 },
  'gemini-cli': { tier: 'experimental', priority: 960 },
  'github-copilot': { tier: 'experimental', priority: 970 },
  kiro: { tier: 'experimental', priority: 980 },
  qoder: { tier: 'experimental', priority: 990 },
  'codex-app-server': { tier: 'experimental', priority: 1000 },
  auggie: { tier: 'experimental', priority: 1010 },
  zcode: { tier: 'experimental', priority: 1020 },
};

const PROVIDER_ALIASES = {
  pepper: 'chipotle', chipotle: 'chipotle', ddgw: 'duckduckgo-web', felo: 'felo-web',
  tllm: 'theoldllm', unc: 'uncloseai', cfp: 'cloudflare-playground', cxa: 'codex-app-server',
  aug: 'auggie', zc: 'zcode', kr: 'kiro', if: 'qoder', qw: 'qwen', gh: 'github-copilot',
};

const NON_CHAT_PATTERNS = [
  /(^|[\/_-])(tts|speech|audio|whisper|transcrib|embedding|embed|rerank|imagegen|image-gen|text-to-image|video-gen|veo)([\/_-]|$)/i,
  /(^|[\/_-])polly([\/_-]|$)/i,
];
const BLOCKED_MODEL_PATTERNS = [
  /^auto(?:\/|$)/i, /^no-think(?:\/|$)/i, /^opencode(?:-go)?(?:\/|$)/i, /^oc\//i,
  /^nvidia\//i, /big[-_ ]?pickle/i, /(^|[\/_-])(dva|devin|agentic|bridge)([\/_-]|$)/i,
  /(mimo-v2\.5-free|hy3-free|nemotron-3-ultra-free|nemotron-3\.5-lightning-free|x-preview-f-free|muse-spark-1\.2-contributor-free)/i,
];
const MODEL_FAILURE_TTL = {
  MODEL_UNAVAILABLE: 6 * 60 * 60 * 1000, BAD_ROUTE: 60 * 60 * 1000, PAID_MODEL: 12 * 60 * 60 * 1000,
  UPSTREAM: 2 * 60 * 1000, RATE_LIMIT: 90 * 1000, ACCESS: 30 * 60 * 1000, UNKNOWN: 60 * 1000,
};
const PROVIDER_FAILURE_TTL = { ACCESS: 30 * 60 * 1000, RATE_LIMIT: 90 * 1000, UPSTREAM: 2 * 60 * 1000 };

function csv(name) { return String(process.env[name] || '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean); }
function providerFromModel(model) {
  const first = String(model || '').trim().toLowerCase().split('/')[0];
  return PROVIDER_ALIASES[first] || first || 'unknown';
}
function isNonChatModel(model) { return NON_CHAT_PATTERNS.some((pattern) => pattern.test(String(model || '').trim())); }
function isBlockedModel(model) {
  const value = String(model || '').trim();
  return !value || BLOCKED_MODEL_PATTERNS.some((pattern) => pattern.test(value)) || isNonChatModel(value);
}
function allowExperimental() { return /^(1|true|yes|on)$/i.test(String(process.env.ULTRON_M3_ALLOW_EXPERIMENTAL_PROVIDERS || '')); }
function allowUnknown() { return /^(1|true|yes|on)$/i.test(String(process.env.ULTRON_M3_ALLOW_UNKNOWN_PROVIDERS || '')); }
function policyAllows(provider) {
  const normalized = String(provider || '').toLowerCase();
  const allowlist = csv('ULTRON_M3_PROVIDER_ALLOWLIST');
  const denylist = new Set(csv('ULTRON_M3_PROVIDER_DENYLIST'));
  if (denylist.has(normalized)) return false;
  if (allowlist.length) return allowlist.includes(normalized);
  const def = PROVIDERS[normalized];
  if (!def) return allowUnknown();
  return def.tier !== 'experimental' || allowExperimental();
}
function stateTemplate() { return { version: 2, providers: {}, models: {}, updatedAt: null }; }
function loadState() {
  const state = readJson(config.providerHealthPath, stateTemplate());
  if (!state || typeof state !== 'object' || state.version !== 2) return stateTemplate();
  state.providers ||= {}; state.models ||= {}; return state;
}
function saveState(state) { state.version = 2; state.updatedAt = new Date().toISOString(); writeJsonAtomic(config.providerHealthPath, state); }
function resetTransientHealth() {
  const state = loadState();
  for (const provider of Object.values(state.providers)) {
    provider.disabledUntil = null;
    provider.lastFailureKind = null;
    provider.lastFailureMessage = null;
    if (provider.healthyModel) provider.status = 'healthy'; else provider.status = 'unknown';
  }
  for (const model of Object.values(state.models)) {
    model.disabledUntil = null;
    model.lastFailureKind = null;
    model.lastFailureMessage = null;
    if (model.lastSuccessAt) model.status = 'healthy'; else model.status = 'unknown';
  }
  saveState(state);
}
function activeUntil(entry) {
  const until = Date.parse(entry?.disabledUntil || '');
  return Number.isFinite(until) && until > Date.now() ? until : 0;
}
function modelAvailable(model, state) { return !activeUntil(state.models?.[model]); }
function providerAvailable(provider, state) { return policyAllows(provider) && !activeUntil(state.providers?.[provider]); }

async function credentialSnapshot() {
  let stored = {};
  try { stored = await loadCredentials(); } catch {}
  const out = {};
  for (const [provider, def] of Object.entries(PROVIDERS)) {
    out[provider] = (def.credentials || []).some((name) => String(process.env[name] || stored[name] || '').trim());
  }
  return out;
}

function taskModelScore(model, taskType = 'general') {
  const value = String(model || '').toLowerCase();
  const task = String(taskType || 'general').toLowerCase();
  let score = 0;
  if (/latest|stable/.test(value)) score += 5;
  if (/preview|experimental|exp\b/.test(value)) score -= 12;
  if (/flash|mini|lite|small|fast/.test(value)) score += ['general', 'simple_qa', 'automation'].includes(task) ? 18 : 4;
  if (/chat|instruct/.test(value)) score += 8;
  if (/code|coder|coding/.test(value)) score += task === 'coding' ? 20 : 2;
  if (/reason|think|pro|sonnet/.test(value)) score += ['research', 'planning', 'coding'].includes(task) ? 14 : 3;
  return score;
}

async function buildCandidates(catalog, requestedModel = 'auto', taskType = 'general', options = {}) {
  const state = loadState();
  const creds = await credentialSnapshot();
  const maxCandidates = Math.max(2, Number(options.maxCandidates || process.env.ULTRON_M3_ROUTER_MAX_CANDIDATES || 6));
  const deepModels = Math.max(2, Number(process.env.ULTRON_M3_CONFIGURED_MODELS_PER_PROVIDER || 3));
  const shallowModels = Math.max(1, Number(process.env.ULTRON_M3_UNCONFIGURED_MODELS_PER_PROVIDER || 1));
  const exclude = new Set(options.exclude || []);
  const raw = [...new Set((catalog || []).map((value) => String(value || '').trim()).filter(Boolean))]
    .filter((model) => !isBlockedModel(model) && !exclude.has(model));

  const requested = String(requestedModel || '').trim();
  const explicit = requested && requested !== 'auto' && raw.includes(requested)
    && providerAvailable(providerFromModel(requested), state) && modelAvailable(requested, state) ? [requested] : [];

  const grouped = new Map();
  for (const model of raw) {
    if (explicit.includes(model)) continue;
    const provider = providerFromModel(model);
    if (!providerAvailable(provider, state) || !modelAvailable(model, state)) continue;
    if (!grouped.has(provider)) grouped.set(provider, []);
    grouped.get(provider).push(model);
  }

  const rows = [...grouped.keys()].map((provider) => {
    const def = PROVIDERS[provider] || { tier: 'unknown', priority: 500 };
    const health = state.providers?.[provider] || {};
    const recentSuccess = Boolean(health.lastSuccessAt && Date.now() - Date.parse(health.lastSuccessAt) < config.providerHealthTtlMs);
    const credentialDetected = Boolean(creds[provider]);
    const unconfiguredPenalty = def.tier === 'api' && !credentialDetected && !recentSuccess ? 250 : 0;
    return {
      provider,
      health,
      recentSuccess,
      credentialDetected,
      priority: Number(def.priority || 500) + unconfiguredPenalty - (credentialDetected ? 200 : 0) - (recentSuccess ? 350 : 0),
    };
  }).sort((a, b) => a.priority - b.priority || a.provider.localeCompare(b.provider));

  const ordered = [...explicit];
  for (const row of rows) {
    const limit = row.credentialDetected || row.recentSuccess ? deepModels : shallowModels;
    const models = (grouped.get(row.provider) || []).sort((a, b) => {
      if (a === row.health.healthyModel && b !== row.health.healthyModel) return -1;
      if (b === row.health.healthyModel && a !== row.health.healthyModel) return 1;
      return taskModelScore(b, taskType) - taskModelScore(a, taskType) || a.localeCompare(b);
    });
    ordered.push(...models.slice(0, limit));
    if (ordered.length >= maxCandidates) break;
  }
  return [...new Set(ordered)].slice(0, maxCandidates);
}

function recordSuccess(model) {
  const provider = providerFromModel(model); const state = loadState(); const now = new Date().toISOString();
  state.providers[provider] = { ...(state.providers[provider] || {}), status: 'healthy', healthyModel: model, lastSuccessAt: now, lastFailureKind: null, lastFailureMessage: null, disabledUntil: null };
  state.models[model] = { ...(state.models[model] || {}), status: 'healthy', lastSuccessAt: now, lastFailureKind: null, lastFailureMessage: null, disabledUntil: null };
  saveState(state);
}
function recordFailure(model, kind, message) {
  const provider = providerFromModel(model); const state = loadState(); const now = Date.now();
  const modelTtl = MODEL_FAILURE_TTL[kind] || MODEL_FAILURE_TTL.UNKNOWN;
  state.models[model] = { ...(state.models[model] || {}), status: 'unhealthy', lastFailureAt: new Date(now).toISOString(), lastFailureKind: kind, lastFailureMessage: String(message || '').slice(0, 500), disabledUntil: new Date(now + modelTtl).toISOString() };
  const providerTtl = PROVIDER_FAILURE_TTL[kind];
  if (providerTtl) state.providers[provider] = { ...(state.providers[provider] || {}), status: 'cooldown', lastFailureAt: new Date(now).toISOString(), lastFailureKind: kind, lastFailureMessage: String(message || '').slice(0, 500), disabledUntil: new Date(now + providerTtl).toISOString() };
  saveState(state);
}

async function snapshot(catalog = []) {
  const state = loadState(); const creds = await credentialSnapshot();
  const names = [...new Set([...Object.keys(PROVIDERS), ...(catalog || []).map(providerFromModel)])];
  const providers = names.map((provider) => {
    const def = PROVIDERS[provider] || { tier: 'unknown', priority: 500 }; const health = state.providers?.[provider] || {};
    return {
      provider, tier: def.tier, enabled: policyAllows(provider), credentialDetected: Boolean(creds[provider]),
      catalogModels: (catalog || []).filter((model) => providerFromModel(model) === provider && !isBlockedModel(model)).length,
      healthyModel: health.healthyModel || null, lastSuccessAt: health.lastSuccessAt || null,
      lastFailureKind: health.lastFailureKind || null, disabledUntil: health.disabledUntil || null,
    };
  }).filter((row) => row.catalogModels || row.credentialDetected || row.healthyModel);
  return {
    mode: 'managed-omniroute', experimentalEnabled: allowExperimental(), unknownProvidersEnabled: allowUnknown(),
    providers: providers.sort((a, b) => (PROVIDERS[a.provider]?.priority || 500) - (PROVIDERS[b.provider]?.priority || 500)),
    healthyProvider: providers.find((row) => row.healthyModel && row.enabled) || null,
  };
}

module.exports = { PROVIDERS, providerFromModel, isBlockedModel, isNonChatModel, policyAllows, buildCandidates, recordSuccess, recordFailure, resetTransientHealth, snapshot, credentialSnapshot };
