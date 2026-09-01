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
  return !value || /^auto(?:\/|$)/.test(value) || /^omniroute\//.test(value) || /^no-think(?:\/|$)/.test(value) || /^(?:oc|opencode)(?:\/|$)/.test(value);
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
  if (!first) return 'unknown';
  const map = { vertex: 'vertex', nvidia: 'nvidia', pollinations: 'pollinations', opencode: 'opencode', zenmux: 'zenmux', bytez: 'bytez' };
  return map[first] || first;
}

function isProviderCredentialError(error) {
  const status = Number(error?.status || 0);
  if (![401, 403, 404].includes(status)) return false;
  const text = `${error?.message || ''} ${stringifyError(error?.body || '')}`.toLowerCase();
  return /no active credentials for provider|api keys are not supported|expected oauth2|oauth2 access token|oauth 2|provider authentication|authentication credentials that assert a principal|invalid_api_key|credentials.*provider/.test(text);
}

function providerPriority(modelId) {
  const provider = providerFromModel(modelId);
  const order = ['nvidia', 'pollinations', 'opencode', 'zenmux', 'bytez', 'vertex'];
  const index = order.indexOf(provider);
  return index === -1 ? 100 : index;
}

async function concreteModels(limit = 12) {
  const available = payloadModels(await models()).filter(isDirectProviderModel);
  available.sort((a, b) => providerPriority(a) - providerPriority(b));
  const usable = available.slice(0, Math.max(1, Number(limit) || 12));
  if (!usable.length) throw new Error('OmniRoute /models returned no enabled-provider models after removing routing aliases, Devin, and Big Pickle.');
  return usable;
}

async function concreteModel() { return (await concreteModels(1))[0]; }

async function chat(messages, model, tools) {
  const key = await resolveOmniRouteApiKey();
  if (!key) throw new Error('OmniRoute Endpoint API key is not configured.');
  const requested = String(model || '').trim();
  let candidates = requested && isDirectProviderModel(requested) && !config.omniRouteStrict ? [requested] : await concreteModels(Math.max(8, Number(process.env.ULTRON_M3_MODEL_CANDIDATES || 12)));
  if (requested && isDirectProviderModel(requested)) candidates = [requested, ...candidates.filter((id) => id !== requested)];

  const failures = [];
  for (const selected of [...new Set(candidates)]) {
    try {
      const data = await requestJson(config.omnirouteBase + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({ model: selected, messages, stream: false, ...(Array.isArray(tools) && tools.length ? { tools } : {}) }),
      }, 120000);
      data.__ultron = { provider: providerFromModel(selected), model: selected };
      return data;
    } catch (error) {
      error.model = selected;
      error.provider = providerFromModel(selected);
      failures.push({ model: selected, provider: error.provider, status: error.status || null, message: error.message });
      if (!isProviderCredentialError(error) && !(Number(error?.status) >= 500 && Number(error?.status) <= 599)) throw error;
    }
  }
  const summary = failures.map((x) => `${x.provider}/${x.model}: ${x.status || 'ERR'} ${x.message}`).join(' | ');
  const error = new Error(`OmniRoute could not find a working enabled-provider model. Tried ${failures.length} candidates. ${summary}`);
  error.status = failures.at(-1)?.status || 503;
  error.failures = failures;
  throw error;
}

async function speak(text) {
  return requestJson(config.parentCore + '/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, provider: 'fish-audio-s2.1-pro-free', format: 'mp3', volume: 2, temperature: 0.70, topP: 0.76, prosody: { speed: 1, volume: 2, normalize_loudness: true }, chunkLength: 240, conditionOnPreviousChunks: true }) }, 120000);
}

module.exports = { requestJson, resolveOmniRouteApiKey, githubReadFile, githubList, models, payloadModels, isRoutingAlias, isDevinModel, isBigPickle, isDirectProviderModel, providerFromModel, isProviderCredentialError, concreteModels, concreteModel, chat, speak };
