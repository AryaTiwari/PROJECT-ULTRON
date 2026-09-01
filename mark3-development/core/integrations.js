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

function isBridgeModelId(id) {
  const value = String(id || '').trim().toLowerCase();
  if (!value) return false;
  const segments = value.split(/[\\/_-]+/).filter(Boolean);
  return segments.includes('dva') || segments.includes('devin') || segments.includes('agentic');
}

function isRoutingAlias(id) {
  const value = String(id || '').trim().toLowerCase();
  if (!value) return true;
  if (/^auto(?:\/|$)/i.test(value)) return true;
  if (/^omniroute\//i.test(value)) return true;
  // A no-think wrapper around a bridge model is still an explicit agentic model.
  if (/^no-think(?:\/|$)/i.test(value) && !isBridgeModelId(value)) return true;
  if (/^(?:oc|opencode)(?:\/|$)/i.test(value)) return true;
  return false;
}

function isBigPickle(id) { return /big[-_ ]?pickle/i.test(String(id || '')); }

function isConcreteModelId(id) {
  const value = String(id || '').trim();
  return Boolean(value && !isRoutingAlias(value) && !isBigPickle(value) && !isBridgeModelId(value));
}

function isBridgeCapableModelId(id) {
  const value = String(id || '').trim();
  return Boolean(value && !isRoutingAlias(value) && !isBigPickle(value) && isBridgeModelId(value));
}

function isBridgeInfrastructureError(error) {
  const body = stringifyError(error?.body || '');
  const text = `${error?.message || ''} ${body}`.toLowerCase();
  return /devin_agentic_home|unknown_devin_model|devin[_ -]?agentic|acp|bridge sandbox|agentic bridge/.test(text);
}

async function concreteModels(limit = 12) {
  const payload = await models();
  const available = payloadModels(payload).filter(isConcreteModelId);
  if (!available.length) throw new Error('OmniRoute /models returned no direct-provider models.');
  return available.slice(0, Math.max(1, Number(limit) || 12));
}

async function bridgeModels(limit = 12) {
  const payload = await models();
  const available = payloadModels(payload).filter(isBridgeCapableModelId);
  if (!available.length) throw new Error('OmniRoute /models returned no Devin agentic bridge models.');
  return available.slice(0, Math.max(1, Number(limit) || 12));
}

function payloadModels(payload) {
  const raw = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  return [...new Set(raw.map((item) => typeof item === 'string' ? item : item?.id || item?.model || item?.name || '').map(String).map((value) => value.trim()).filter(Boolean))];
}

async function concreteModel() { return (await concreteModels(1))[0]; }

async function bridgeModel() {
  const preferred = String(config.agenticBridgeModel || '').trim();
  const available = await bridgeModels(Math.max(12, Number(process.env.ULTRON_M3_BRIDGE_MODEL_CANDIDATES || 12)));
  return preferred && available.includes(preferred) ? preferred : available[0];
}

async function chat(messages, model, tools) {
  const key = await resolveOmniRouteApiKey();
  if (!key) throw new Error('OmniRoute Endpoint API key is not configured.');

  const requested = String(model || '').trim();
  const bridgeRequested = isBridgeCapableModelId(requested);
  let candidates;
  if (bridgeRequested && config.agenticBridgeEnabled) {
    const alternates = await bridgeModels(Number(process.env.ULTRON_M3_BRIDGE_MODEL_CANDIDATES || 6)).catch(() => []);
    candidates = [requested, ...alternates.filter((id) => id !== requested)];
  } else if (bridgeRequested) {
    throw new Error(`Agentic bridge model requested while Devin bridge support is disabled: ${requested}`);
  } else if (requested && isConcreteModelId(requested) && !config.omniRouteStrict) {
    candidates = [requested];
  } else {
    candidates = await concreteModels(Math.max(5, Number(process.env.ULTRON_M3_MODEL_CANDIDATES || 8)));
    if (requested && isConcreteModelId(requested)) candidates.unshift(requested);
  }

  let lastError = null;
  for (const selected of [...new Set(candidates)]) {
    try {
      return await requestJson(config.omnirouteBase + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({ model: selected, messages, stream: false, ...(Array.isArray(tools) && tools.length ? { tools } : {}) }),
      }, bridgeRequested ? config.agenticBridgeTimeoutMs : 120000);
    } catch (error) {
      error.model = selected;
      error.provider = isBridgeCapableModelId(selected) ? 'devin-agentic-bridge' : 'omniroute';
      lastError = error;
      if (bridgeRequested && isBridgeInfrastructureError(error)) continue;
      if (!Number(error?.status) || error.status < 500 || error.status > 599) throw error;
    }
  }

  throw lastError || new Error(`OmniRoute: all ${bridgeRequested ? 'agentic bridge' : 'direct-provider'} candidates failed.`);
}

async function speak(text) {
  return requestJson(config.parentCore + '/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, provider: 'fish-audio-s2.1-pro-free', format: 'mp3', volume: 2, temperature: 0.70, topP: 0.76, prosody: { speed: 1, volume: 2, normalize_loudness: true }, chunkLength: 240, conditionOnPreviousChunks: true }) }, 120000);
}

module.exports = { requestJson, resolveOmniRouteApiKey, githubReadFile, githubList, models, payloadModels, isConcreteModelId, isBridgeModelId, isBridgeCapableModelId, concreteModels, bridgeModels, concreteModel, bridgeModel, chat, speak };