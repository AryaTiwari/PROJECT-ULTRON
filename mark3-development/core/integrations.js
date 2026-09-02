const fs = require('fs');
const path = require('path');
const config = require('./config');
const { load: loadCredentials } = require('../../core/credentials/local-store');
const parentRouter = require('../../core/omniroute');

function readParentEnv(name) {
  try {
    const envPath = path.resolve(__dirname, '..', '..', '.env');
    if (!fs.existsSync(envPath)) return '';
    const line = fs.readFileSync(envPath, 'utf8').split(/\r?\n/).find((entry) => entry.trim().startsWith(name + '='));
    return line ? line.slice(line.indexOf('=') + 1).trim().replace(/^['\"]|['\"]$/g, '') : '';
  } catch { return ''; }
}

async function resolveOmniRouteApiKey() {
  const direct = String(config.omnirouteEndpointKey || process.env.OMNIROUTE_ENDPOINT_KEY || process.env.OMNIROUTE_API_KEY || process.env.ULTRON_OMNIROUTE_API_KEY || '').trim();
  if (direct) return direct;
  for (const name of ['OMNIROUTE_ENDPOINT_KEY', 'OMNIROUTE_API_KEY', 'ULTRON_OMNIROUTE_API_KEY']) {
    const env = readParentEnv(name);
    if (env) return env;
  }
  try {
    const saved = await loadCredentials();
    return String(saved.OMNIROUTE_ENDPOINT_KEY || saved.OMNIROUTE_API_KEY || saved.ULTRON_OMNIROUTE_API_KEY || '').trim();
  } catch { return ''; }
}

function isRoutingAlias(id) {
  const value = String(id || '').trim().toLowerCase();
  return !value || /^auto(?:\/|$)/.test(value) || /^omniroute\//.test(value) || /^no-think(?:\/|$)/.test(value);
}
function isDevinModel(id) {
  const value = String(id || '').trim().toLowerCase();
  return /(^|[\\/_-])(dva|devin|agentic|bridge)([\\/_-]|$)/i.test(value);
}

// Big Pickle is disabled completely for Mark 3 testing/runtime selection.
function isBigPickle(id) {
  return /big[-_ ]?pickle/i.test(String(id || ''));
}

function isDirectProviderModel(id) {
  const value = String(id || '').trim();
  return Boolean(value && !isRoutingAlias(value) && !isDevinModel(value) && !isBigPickle(value));
}

function providerFromModel(id) {
  const first = String(id || '').split('/')[0].trim().toLowerCase();
  const aliases = { pepper:'chipotle', chipotle:'chipotle', ddgw:'duckduckgo-web', felo:'felo-web', tllm:'theoldllm', unc:'uncloseai', cfp:'cloudflare-playground', cxa:'codex-app-server', aug:'auggie', zc:'zcode', kr:'kiro', kiro:'kiro', if:'qoder', qoder:'qoder', qw:'qwen', qwen:'qwen', gh:'github-copilot', 'github-copilot':'github-copilot', oc:'opencode', opencode:'opencode', pol:'pollinations', pollinations:'pollinations', zm:'zenmux', zenmux:'zenmux', nvidia:'nvidia', bytez:'bytez', vertex:'vertex' };
  return aliases[first] || first || 'unknown';
}

function classifyProviderError(error) {
  const status = Number(error?.status || 0);
  const text = `${error?.message || ''} ${error?.raw || error?.body || ''}`.toLowerCase();
  if (status === 402 || /payment_required|payment required|billing_error|paid model/.test(text)) return 'PAID_MODEL';
  if ([401,403].includes(status) || /missing api key|invalid_api_key|no active credentials|authentication failed|permission|forbidden/.test(text)) return 'CREDENTIALS_OR_ACCESS';
  if (status === 404 || /model.*not.*found|model.*does not exist|not available/.test(text)) return 'MODEL_UNAVAILABLE';
  if (status === 429 || /quota|rate limit|exhausted|anti-abuse|too many requests/.test(text)) return 'QUOTA_OR_RATE_LIMIT';
  if (status >= 500 || /gateway|timed out|fetch failed|econnrefused|blocked by/.test(text)) return 'UPSTREAM_OR_NETWORK';
  return 'UNKNOWN';
}
function isProviderCredentialError(error) { return classifyProviderError(error) === 'CREDENTIALS_OR_ACCESS'; }
function isPaidModelError(error) { return classifyProviderError(error) === 'PAID_MODEL'; }
function isRetryableCandidateError(error) { return classifyProviderError(error) !== 'UNKNOWN'; }

async function models() {
  const data = await parentRouter.listModels({ force: true });
  return { data: data.map((id) => ({ id })) };
}
function payloadModelEntries(payload) {
  const raw = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  return raw.map((item) => typeof item === 'string' ? { id: item.trim(), raw: { id: item.trim() } } : { id: String(item?.id || item?.model || item?.name || '').trim(), raw: item }).filter((item) => item.id && !isBigPickle(item.id));
}
function payloadModels(payload) { return [...new Set(payloadModelEntries(payload).map((item) => item.id))]; }
async function concreteModels(limit = 36) {
  const raw = await parentRouter.listModels({ force: false });
  return raw.map((id) => String(id).trim()).filter((id) => isDirectProviderModel(id)).map((id) => ({ id, raw: { id } })).slice(0, Math.max(1, Number(limit) || 36));
}
async function concreteModel() { return (await concreteModels(1))[0]?.id || ''; }
async function resolveModel(requestedModel = 'auto', taskType = 'general') {
  if (isBigPickle(requestedModel)) return safeModelForTask(taskType);
  const resolved = await parentRouter.resolveModel(requestedModel, taskType);
  return isBigPickle(resolved) ? safeModelForTask(taskType) : resolved;
}

function safeModelForTask(taskType) {
  const configured = String(process.env.ULTRON_M3_SAFE_MODEL || '').trim();
  if (configured && !isBigPickle(configured)) return configured;
  // Known-good OmniRoute provider confirmed working during Mark 2/Mark 3 diagnostics.
  return 'nvidia/nvidia/nemotron-3-super-120b-a12b';
}

async function chat(messages, model = 'auto', tools = null, options = {}) {
  const taskType = options.taskType || 'general';
  const requested = String(model || 'auto').trim();
  const selected = isRoutingAlias(requested) || isBigPickle(requested) ? safeModelForTask(taskType) : requested;
  const result = await parentRouter.chat({ messages, model: selected, taskType, tools });
  if (isBigPickle(result?.model)) {
    const fallback = safeModelForTask(taskType);
    const retry = await parentRouter.chat({ messages, model: fallback, taskType, tools });
    if (isBigPickle(retry?.model)) throw new Error('Big Pickle is blocked from Mark 3 runtime selection.');
    return retry;
  }
  return result;
}

async function streamChat(messages, model = 'auto', tools = null, options = {}) {
  const taskType = options.taskType || 'general';
  const requested = String(model || 'auto').trim();
  const selected = isRoutingAlias(requested) || isBigPickle(requested) ? safeModelForTask(taskType) : requested;
  return parentRouter.streamChat({ messages, model: selected, taskType, tools, onDelta: options.onDelta, firstTokenTimeoutMs: options.firstTokenTimeoutMs });
}
async function chatExact(messages, model, tools) {
  const selected = isBigPickle(model) || isRoutingAlias(model) ? safeModelForTask('general') : model;
  return chat(messages, selected, tools, { taskType: 'general' });
}
async function health() { return parentRouter.health(); }
function providerHealthSnapshot() { return []; }

async function speak(text) {
  const response = await fetch(`${config.parentCore}/api/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, provider: 'fish-audio-s2.1-pro-free', format: 'mp3', volume: 2 }),
  });
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  if (!response.ok) {
    const error = new Error(`ULTRON TTS HTTP ${response.status}: ${String(raw).slice(0, 1200)}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function requestJson(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...(options || {}), signal: controller.signal });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!response.ok) { const error = new Error(`HTTP ${response.status}: ${text.slice(0, 2500)}`); error.status = response.status; error.body = data; throw error; }
    return data;
  } finally { clearTimeout(timer); }
}

async function githubReadFile(pathname, ref) {
  if (!config.githubToken) throw new Error('GITHUB_TOKEN is not configured.');
  const useRef = ref || config.githubBranch;
  const url = `https://api.github.com/repos/${encodeURIComponent(config.githubOwner)}/${encodeURIComponent(config.githubRepo)}/contents/${String(pathname || '').split('/').filter(Boolean).map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(useRef)}`;
  const data = await requestJson(url, { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${config.githubToken}` } }, 20000);
  if (data.type !== 'file' || !data.content) throw new Error(`GitHub path is not a readable file: ${pathname}`);
  return { path: pathname, ref: useRef, sha: data.sha, content: Buffer.from(String(data.content).replace(/\r?\n/g, ''), 'base64').toString('utf8'), size: Number(data.size) || 0 };
}
async function githubList(pathname = '', ref) {
  if (!config.githubToken) throw new Error('GITHUB_TOKEN is not configured.');
  const useRef = ref || config.githubBranch;
  const suffix = pathname ? '/' + String(pathname).split('/').filter(Boolean).map(encodeURIComponent).join('/') : '';
  return requestJson(`https://api.github.com/repos/${encodeURIComponent(config.githubOwner)}/${encodeURIComponent(config.githubRepo)}/contents${suffix}?ref=${encodeURIComponent(useRef)}`, { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${config.githubToken}` } }, 20000);
}

module.exports = { requestJson, resolveOmniRouteApiKey, githubReadFile, githubList, models, payloadModels, payloadModelEntries, resolveModel, isRoutingAlias, isDevinModel, isBigPickle, isDirectProviderModel, providerFromModel, classifyProviderError, isProviderCredentialError, isPaidModelError, isRetryableCandidateError, concreteModels, concreteModel, chatExact, chat, streamChat, health, providerHealthSnapshot, speak, PROVIDER_PRIORITY: ['nvidia', 'chipotle', 'duckduckgo-web', 'felo-web', 'theoldllm', 'uncloseai', 'cloudflare-playground', 'codex-app-server', 'auggie', 'zcode', 'gemini-cli', 'kiro', 'qoder', 'qwen', 'github-copilot', 'opencode', 'pollinations', 'zenmux', 'bytez', 'vertex'] };