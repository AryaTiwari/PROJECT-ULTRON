const fs = require('fs');
const path = require('path');
const config = require('./config');
const { load: loadCredentials } = require('../../core/credentials/local-store');
const parentRouter = require('../../core/model-router');
const directRouter = require('../../core/direct-model-router');
const omniRoute = require('../../core/omniroute');

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
function isBigPickle(id) { return /big[-_ ]?pickle/i.test(String(id || '')); }
function isOpenCodeModel(id) {
  const value = String(id || '').trim().toLowerCase();
  return value === 'opencode' || value.startsWith('opencode/') || value.startsWith('opencode-go/') || value.startsWith('oc/') || value.includes('big-pickle') || value.includes('big_pickle') || value.includes('big pickle');
}
function isDirectProviderModel(id) {
  const value = String(id || '').trim();
  return Boolean(value && !isRoutingAlias(value) && !isDevinModel(value) && !isBigPickle(value) && !isOpenCodeModel(value));
}
function providerFromModel(id) {
  const first = String(id || '').split('/')[0].trim().toLowerCase();
  const aliases = { pepper:'chipotle', chipotle:'chipotle', ddgw:'duckduckgo-web', felo:'felo-web', tllm:'theoldllm', unc:'uncloseai', cfp:'cloudflare-playground', cxa:'codex-app-server', aug:'auggie', zc:'zcode', kr:'kiro', kiro:'kiro', if:'qoder', qoder:'qoder', qw:'qwen', qwen:'qwen', gh:'github-copilot', 'github-copilot':'github-copilot', oc:'opencode', opencode:'opencode', 'opencode-go':'opencode', pol:'pollinations', pollinations:'pollinations', zm:'zenmux', zenmux:'zenmux', nvidia:'nvidia', bytez:'bytez', vertex:'vertex' };
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
  try {
    const data = await omniRoute.listModels({ force: true });
    return { data: data.map((id) => ({ id })).filter((item) => !isOpenCodeModel(item.id) && !isBigPickle(item.id)) };
  } catch (error) {
    return { data: [], error: error.message };
  }
}
function payloadModelEntries(payload) {
  const raw = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  return raw.map((item) => typeof item === 'string' ? { id: item.trim(), raw: { id: item.trim() } } : { id: String(item?.id || item?.model || item?.name || '').trim(), raw: item }).filter((item) => item.id && !isBigPickle(item.id) && !isOpenCodeModel(item.id));
}
function payloadModels(payload) { return [...new Set(payloadModelEntries(payload).map((item) => item.id))]; }
async function concreteModels(limit = 36) {
  const raw = await models();
  return payloadModelEntries(raw).filter((entry) => isDirectProviderModel(entry.id)).slice(0, Math.max(1, Number(limit) || 36));
}
async function concreteModel() { return (await concreteModels(1))[0]?.id || ''; }

function directProviderModel(provider) {
  const defaults = {
    gemini: process.env.ULTRON_DIRECT_GEMINI_MODEL || 'gemini-2.5-flash',
    openai: 'gpt-5.4-mini',
    anthropic: 'claude-sonnet-4-5',
    deepseek: 'deepseek-chat',
    groq: 'llama-3.3-70b-versatile',
    mistral: 'mistral-small-latest',
    xai: 'grok-4',
  };
  return defaults[provider] ? `${provider}/${defaults[provider]}` : '';
}

async function selectNonOpenCodeDirectModel() {
  const envOverride = String(process.env.ULTRON_DIRECT_DEFAULT_MODEL || '').trim();
  if (envOverride && !isOpenCodeModel(envOverride) && !isBigPickle(envOverride) && directRouter.providerForModel(envOverride)) {
    const creds = await loadCredentials().catch(() => ({}));
    const provider = directRouter.providerForModel(envOverride);
    if (creds?.[directRouter.PROVIDERS?.[provider]?.key] || process.env[directRouter.PROVIDERS?.[provider]?.key || '']) return envOverride;
  }

  const saved = await loadCredentials().catch(() => ({}));
  const env = process.env;
  const candidates = ['gemini', 'openai', 'anthropic', 'deepseek', 'groq', 'mistral', 'xai'];
  for (const provider of candidates) {
    const key = directRouter.PROVIDERS?.[provider]?.key;
    if (key && String(saved?.[key] || env[key] || '').trim()) return directProviderModel(provider);
  }
  return '';
}

async function selectMark2Model(model = 'auto', taskType = 'general') {
  const requested = String(model || 'auto').trim();
  if (requested && requested !== 'auto' && !isRoutingAlias(requested) && !isBigPickle(requested) && !isOpenCodeModel(requested)) return requested;
  if (requested && (isBigPickle(requested) || isOpenCodeModel(requested))) throw new Error(`OpenCode is disabled in Mark 3: ${requested}`);

  const directReplacement = await selectNonOpenCodeDirectModel();
  if (directReplacement) return directReplacement;

  try {
    const selected = await omniRoute.resolveModel(requested && !isRoutingAlias(requested) ? requested : 'auto', taskType);
    if (!isBigPickle(selected) && !isOpenCodeModel(selected)) return selected;
  } catch {}

  const fallback = await concreteModel().catch(() => '');
  if (fallback && !isOpenCodeModel(fallback) && !isBigPickle(fallback)) return fallback;

  throw new Error('No non-OpenCode model is currently available for Mark 3.');
}

async function resolveModel(requestedModel = 'auto', taskType = 'general') {
  return selectMark2Model(requestedModel, taskType);
}

async function chat(messages, model = 'auto', tools = null, options = {}) {
  const taskType = options.taskType || 'general';
  const selected = await selectMark2Model(model, taskType);
  if (isOpenCodeModel(selected) || isBigPickle(selected)) throw new Error(`Mark 3 rejected disabled model: ${selected}`);
  return parentRouter.chat({ messages, model: selected, tools, taskType });
}

async function streamChat(messages, model = 'auto', tools = null, options = {}) {
  const taskType = options.taskType || 'general';
  const selected = await selectMark2Model(model, taskType);
  if (isOpenCodeModel(selected) || isBigPickle(selected)) throw new Error(`Mark 3 rejected disabled model: ${selected}`);
  return parentRouter.streamChat({ messages, model: selected, taskType, tools, onDelta: options.onDelta, firstTokenTimeoutMs: options.firstTokenTimeoutMs });
}

async function chatExact(messages, model, tools) {
  if (isOpenCodeModel(model) || isBigPickle(model)) throw new Error(`Disabled model: ${model}`);
  return chat(messages, model, tools, { taskType: 'general' });
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
const jsonRequest = requestJson;

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

module.exports = { requestJson, jsonRequest, resolveOmniRouteApiKey, githubReadFile, githubList, models, payloadModels, payloadModelEntries, resolveModel, isRoutingAlias, isDevinModel, isBigPickle, isOpenCodeModel, isDirectProviderModel, providerFromModel, classifyProviderError, isProviderCredentialError, isPaidModelError, isRetryableCandidateError, concreteModels, concreteModel, chatExact, chat, streamChat, health, providerHealthSnapshot, speak, selectMark2Model, selectNonOpenCodeDirectModel, PROVIDER_PRIORITY: ['nvidia', 'chipotle', 'duckduckgo-web', 'felo-web', 'theoldllm', 'uncloseai', 'cloudflare-playground', 'codex-app-server', 'auggie', 'zcode', 'gemini-cli', 'kiro', 'qoder', 'qwen', 'github-copilot', 'pollinations', 'zenmux', 'bytez', 'vertex'] };