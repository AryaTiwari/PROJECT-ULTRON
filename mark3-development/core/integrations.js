const fs = require('fs');
const path = require('path');
const config = require('./config');
const { load: loadCredentials } = require('../../core/credentials/local-store');

function readParentEnv(name) {
  try {
    const envPath = path.resolve(__dirname, '..', '..', '.env');
    if (!fs.existsSync(envPath)) return '';
    const line = fs.readFileSync(envPath, 'utf8').split(/\r?\n/).find((entry) => entry.trim().startsWith(name + '='));
    if (!line) return '';
    return line.slice(line.indexOf('=') + 1).trim().replace(/^['\"]|['\"]$/g, '');
  } catch { return ''; }
}

async function resolveOmniRouteApiKey() {
  const direct = String(config.omnirouteEndpointKey || process.env.OMNIROUTE_ENDPOINT_KEY || '').trim();
  if (direct) return direct;
  const parent = readParentEnv('OMNIROUTE_ENDPOINT_KEY');
  if (parent) return parent;
  try {
    const saved = await loadCredentials();
    return String(saved.OMNIROUTE_ENDPOINT_KEY || saved.OMNIROUTE_API_KEY || saved.ULTRON_OMNIROUTE_API_KEY || '').trim();
  } catch { return ''; }
}

function withTimeout(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, clear: () => clearTimeout(timer) };
}

function stringifyError(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function extractUpstreamTarget(text) {
  const value = String(text || '');
  const match = value.match(/\[(?<provider>[a-z0-9_-]+)\/(?<model>[^\]]+)\]/i);
  return match?.groups ? { provider: String(match.groups.provider).toLowerCase(), model: String(match.groups.model) } : null;
}

async function requestJson(url, options, timeoutMs = 30000) {
  const timeout = withTimeout(timeoutMs);
  try {
    const response = await fetch(url, { ...(options || {}), signal: timeout.controller.signal });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!response.ok) {
      const detail = data?.error || data?.message || data?.detail || data?.raw || text;
      const error = new Error(`HTTP ${response.status}: ${stringifyError(detail).slice(0, 2000)}`);
      error.status = response.status;
      error.body = data;
      error.upstream = extractUpstreamTarget(String(detail));
      throw error;
    }
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`OmniRoute request timed out after ${timeoutMs}ms.`);
    throw error;
  } finally { timeout.clear(); }
}

function githubHeaders() {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (config.githubToken) headers.Authorization = 'Bearer ' + config.githubToken;
  return headers;
}

function githubPath(value) { return String(value || '').split('/').filter(Boolean).map(encodeURIComponent).join('/'); }

async function githubReadFile(pathname, ref) {
  if (!config.githubToken) throw new Error('GITHUB_TOKEN is not configured.');
  const useRef = ref || config.githubBranch;
  const url = `https://api.github.com/repos/${encodeURIComponent(config.githubOwner)}/${encodeURIComponent(config.githubRepo)}/contents/${githubPath(pathname)}?ref=${encodeURIComponent(useRef)}`;
  const data = await requestJson(url, { headers: githubHeaders() }, 20000);
  if (data.type !== 'file' || !data.content) throw new Error(`GitHub path is not a readable file: ${pathname}`);
  return { path: pathname, ref: useRef, sha: data.sha, content: Buffer.from(String(data.content).replace(/\r?\n/g, ''), 'base64').toString('utf8'), size: Number(data.size) || 0 };
}

async function githubList(pathname = '', ref) {
  if (!config.githubToken) throw new Error('GITHUB_TOKEN is not configured.');
  const useRef = ref || config.githubBranch;
  const suffix = pathname ? '/' + githubPath(pathname) : '';
  const url = `https://api.github.com/repos/${encodeURIComponent(config.githubOwner)}/${encodeURIComponent(config.githubRepo)}/contents${suffix}?ref=${encodeURIComponent(useRef)}`;
  return requestJson(url, { headers: githubHeaders() }, 20000);
}

async function models() {
  const key = await resolveOmniRouteApiKey();
  if (!key) throw new Error('OmniRoute Endpoint API key is not configured.');
  return requestJson(config.omnirouteBase + '/models', { headers: { Authorization: 'Bearer ' + key } }, 15000);
}

function payloadModels(payload) {
  const raw = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  return [...new Set(raw.map((item) => typeof item === 'string' ? item : item?.id || item?.model || item?.name || '').map(String).map((value) => value.trim()).filter(Boolean))];
}

function isRoutingAlias(id) {
  const value = String(id || '').trim().toLowerCase();
  return !value || /^auto(?:\/|$)/.test(value) || /^omniroute\//.test(value) || /^no-think(?:\/|$)/.test(value) || /^oc(?:\/|$)/.test(value);
}

function isDevinModel(id) {
  const value = String(id || '').trim().toLowerCase();
  if (!value) return false;
  const segments = value.split(/[\\/_-]+/).filter(Boolean);
  return segments.includes('dva') || segments.includes('devin') || segments.includes('agentic') || segments.includes('bridge');
}

function isBigPickle(id) { return /big[-_ ]?pickle/i.test(String(id || '')); }

function isDirectProviderModel(id) {
  const value = String(id || '').trim();
  return Boolean(value) && !isRoutingAlias(value) && !isDevinModel(value) && !isBigPickle(value);
}

function providerFromModel(id) {
  const first = String(id || '').split('/')[0].trim().toLowerCase();
  const map = {
    vertex: 'vertex', nvidia: 'nvidia', pollinations: 'pollinations', pol: 'pollinations',
    opencode: 'opencode', oc: 'opencode', zenmux: 'zenmux', zm: 'zenmux', bytez: 'bytez',
    'gemini-cli': 'gemini-cli', kr: 'kiro', kiro: 'kiro', if: 'qoder', qoder: 'qoder',
    qw: 'qwen', qwen: 'qwen', gh: 'github-copilot', 'github-copilot': 'github-copilot',
  };
  return map[first] || first || 'unknown';
}

function classifyProviderError(error) {
  const status = Number(error?.status || 0);
  const text = `${error?.message || ''} ${stringifyError(error?.body || '')}`.toLowerCase();
  if (status === 402 || /payment_required|requires an opencode api key|billing_error|requires .* api key|paid model/.test(text)) return 'PAID_MODEL';
  if ([401, 403].includes(status) || /no active credentials|invalid_api_key|authentication failed|provider authentication|you have no permission/.test(text)) return 'CREDENTIALS_OR_ACCESS';
  if (status === 404 || /model does not exist|model_not_found|not available in the active live catalog/.test(text)) return 'MODEL_UNAVAILABLE';
  if (status === 429 || /quota|rate limit|exhausted/.test(text)) return 'QUOTA_OR_RATE_LIMIT';
  if (status >= 500 || /endpoint is unavailable|upstream request failed|timed out|fetch failed/.test(text)) return 'UPSTREAM_OR_NETWORK';
  return 'UNKNOWN';
}

function isProviderCredentialError(error) { return classifyProviderError(error) === 'CREDENTIALS_OR_ACCESS'; }
function isPaidModelError(error) { return classifyProviderError(error) === 'PAID_MODEL'; }
function isRetryableCandidateError(error) {
  const kind = classifyProviderError(error);
  return kind !== 'UNKNOWN';
}

// Prefer providers that OmniRoute documents as free/OAuth before paid API-key providers.
const PROVIDER_PRIORITY = [
  'gemini-cli', 'kiro', 'qoder', 'qwen', 'github-copilot',
  'opencode', 'pollinations', 'nvidia', 'zenmux', 'bytez', 'vertex',
];
const providerHealth = new Map();

function providerPriority(modelId) {
  const provider = providerFromModel(modelId);
  const index = PROVIDER_PRIORITY.indexOf(provider);
  const health = providerHealth.get(provider);
  const healthPenalty = health?.healthy === false ? 50 : 0;
  return (index === -1 ? 100 : index) * 100 + healthPenalty;
}

function canonicalProviderPrefixes(provider) {
  const prefixes = {
    'gemini-cli': ['gemini-cli/'],
    kiro: ['kr/', 'kiro/'],
    qoder: ['if/', 'qoder/'],
    qwen: ['qw/', 'qwen/'],
    'github-copilot': ['gh/', 'github-copilot/'],
  };
  return prefixes[provider] || [`${String(provider || '').toLowerCase()}/`];
}

function diversifyCandidates(modelIds, limit) {
  const groups = new Map();
  for (const id of modelIds) {
    const provider = providerFromModel(id);
    if (!groups.has(provider)) groups.set(provider, []);
    groups.get(provider).push(id);
  }
  const orderedProviders = [...new Set([...PROVIDER_PRIORITY, ...groups.keys()])];
  const out = [];
  for (const provider of orderedProviders) {
    const group = groups.get(provider) || [];
    const prefixes = canonicalProviderPrefixes(provider);
    const canonical = group.filter((id) => prefixes.some((prefix) => String(id).toLowerCase().startsWith(prefix)));
    const aliases = group.filter((id) => !canonical.includes(id));
    for (const id of [...canonical, ...aliases].slice(0, 6)) out.push(id);
  }
  return out.slice(0, Math.max(1, Number(limit) || 12));
}

async function concreteModels(limit = 36) {
  const available = payloadModels(await models()).filter(isDirectProviderModel);
  available.sort((a, b) => providerPriority(a) - providerPriority(b));
  const diversified = diversifyCandidates(available, Math.max(24, Number(limit) || 36));
  if (!diversified.length) throw new Error('OmniRoute /models returned no eligible models.');
  return diversified;
}

async function concreteModel() { return (await concreteModels(1))[0]; }

async function chatExact(messages, model, tools) {
  const key = await resolveOmniRouteApiKey();
  if (!key) throw new Error('OmniRoute Endpoint API key is not configured.');
  const selected = String(model || '').trim();
  if (!selected || !isDirectProviderModel(selected)) throw new Error(`Invalid direct provider model: ${selected || '(empty)'}`);
  const provider = providerFromModel(selected);
  const data = await requestJson(config.omnirouteBase + '/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({ model: selected, messages, stream: false, ...(Array.isArray(tools) && tools.length ? { tools } : {}) }),
  }, 120000);
  const actualModel = String(data?.model || '').trim();
  const actualProvider = actualModel ? providerFromModel(actualModel) : provider;
  if (actualProvider && actualProvider !== provider && actualProvider !== 'unknown') {
    const mismatch = new Error(`Provider mismatch: requested ${provider}/${selected.split('/').slice(1).join('/')} but OmniRoute returned ${actualProvider}/${actualModel.split('/').slice(1).join('/') || actualModel}.`);
    mismatch.status = 502;
    mismatch.requestedProvider = provider;
    mismatch.requestedModel = selected;
    mismatch.actualProvider = actualProvider;
    mismatch.actualModel = actualModel;
    throw mismatch;
  }
  data.__ultron = { provider, model: selected, actualProvider, actualModel: actualModel || selected, exact: true };
  providerHealth.set(provider, { healthy: true, checkedAt: Date.now(), model: selected });
  return data;
}

async function chat(messages, model, tools) {
  const key = await resolveOmniRouteApiKey();
  if (!key) throw new Error('OmniRoute Endpoint API key is not configured.');
  const requested = String(model || '').trim();
  const limit = Math.max(24, Number(process.env.ULTRON_M3_MODEL_CANDIDATES || 36));
  let candidates = await concreteModels(limit);
  if (requested && isDirectProviderModel(requested)) candidates = [requested, ...candidates.filter((id) => id !== requested)];

  const failures = [];
  const exhaustedProviders = new Set();
  const paidModels = [];
  for (const selected of [...new Set(candidates)]) {
    const provider = providerFromModel(selected);
    if (exhaustedProviders.has(provider)) continue;
    try {
      return await chatExact(messages, selected, tools);
    } catch (error) {
      error.model = selected; error.provider = provider;
      const kind = classifyProviderError(error);
      const upstream = error.upstream?.provider || error.actualProvider || null;
      failures.push({ model: selected, provider, status: error.status || null, message: error.message, kind, upstreamProvider: upstream });
      if (kind === 'PAID_MODEL') { paidModels.push(selected); continue; }
      if (kind === 'CREDENTIALS_OR_ACCESS') {
        providerHealth.set(provider, { healthy: false, checkedAt: Date.now(), error: error.message });
        exhaustedProviders.add(provider);
        continue;
      }
      if (upstream && upstream !== provider) {
        providerHealth.set(provider, { healthy: false, checkedAt: Date.now(), error: error.message, upstreamProvider: upstream });
        exhaustedProviders.add(provider);
        continue;
      }
      if (isRetryableCandidateError(error)) continue;
      throw error;
    }
  }

  const summary = failures.map((x) => `${x.provider}/${x.model}: [${x.kind}] ${x.message}`).join(' | ');
  const paidSummary = paidModels.length ? ` Paid-only models skipped: ${paidModels.length}.` : '';
  const error = new Error(`OmniRoute could not find a working enabled-provider model. Tried ${failures.length} candidates.${paidSummary} ${summary}`);
  error.status = failures.at(-1)?.status || 503;
  error.failures = failures;
  throw error;
}

function providerHealthSnapshot() { return [...providerHealth.entries()].map(([provider, state]) => ({ provider, ...state })); }

async function speak(text) {
  return requestJson(config.parentCore + '/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, provider: 'fish-audio-s2.1-pro-free', format: 'mp3', volume: 2, temperature: 0.70, topP: 0.76, prosody: { speed: 1, volume: 2, normalize_loudness: true }, chunkLength: 240, conditionOnPreviousChunks: true }) }, 120000);
}

module.exports = { requestJson, resolveOmniRouteApiKey, githubReadFile, githubList, models, payloadModels, payloadModelEntries, isRoutingAlias, isDevinModel, isBigPickle, isDirectProviderModel, providerFromModel, classifyProviderError, isProviderCredentialError, isPaidModelError, isRetryableCandidateError, concreteModels, concreteModel, chatExact, chat, providerHealthSnapshot, speak, PROVIDER_PRIORITY };