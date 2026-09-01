const fs = require('fs');
const path = require('path');
const config = require('./config');
const { load: loadCredentials } = require('../../core/credentials/local-store');

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
  const env = readParentEnv('OMNIROUTE_ENDPOINT_KEY');
  if (env) return env;
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
  const match = String(text || '').match(/\[(?<provider>[a-z0-9_-]+)\/(?<model>[^\]]+)\]/i);
  return match?.groups ? { provider: match.groups.provider.toLowerCase(), model: match.groups.model } : null;
}

function classifyProviderError(error) {
  const status = Number(error?.status || 0);
  const text = `${error?.message || ''} ${stringifyError(error?.body || '')}`.toLowerCase();
  if (status === 402 || /payment_required|payment required|billing_error|requires .* api key|paid model/.test(text)) return 'PAID_MODEL';
  if ([401, 403].includes(status) || /missing api key|invalid_api_key|no active credentials|authentication failed|permission|forbidden/.test(text)) return 'CREDENTIALS_OR_ACCESS';
  if (status === 404 || /model.*not.*found|model.*does not exist|not available/.test(text)) return 'MODEL_UNAVAILABLE';
  if (status === 429 || /quota|rate limit|exhausted|anti-abuse|too many requests/.test(text)) return 'QUOTA_OR_RATE_LIMIT';
  if (status >= 500 || /endpoint is unavailable|upstream request failed|gateway|timed out|fetch failed|econnrefused|blocked by/.test(text)) return 'UPSTREAM_OR_NETWORK';
  return 'UNKNOWN';
}

function isProviderCredentialError(error) { return classifyProviderError(error) === 'CREDENTIALS_OR_ACCESS'; }
function isPaidModelError(error) { return classifyProviderError(error) === 'PAID_MODEL'; }
function isRetryableCandidateError(error) { return classifyProviderError(error) !== 'UNKNOWN'; }

function isRoutingAlias(id) {
  const value = String(id || '').trim().toLowerCase();
  return !value || /^auto(?:\/|$)/.test(value) || /^omniroute\//.test(value) || /^no-think(?:\/|$)/.test(value);
}
function isDevinModel(id) {
  const value = String(id || '').trim().toLowerCase();
  return /(^|[\\/_-])(dva|devin|agentic|bridge)([\\/_-]|$)/i.test(value);
}
function isBigPickle(id) { return config.disableBigPickle !== false && /big[-_ ]?pickle/i.test(String(id || '')); }
function isDirectProviderModel(id) { const value = String(id || '').trim(); return Boolean(value && !isRoutingAlias(value) && !isDevinModel(value) && !isBigPickle(value)); }

const PROVIDER_PRIORITY = ['nvidia','chipotle','duckduckgo-web','felo-web','theoldllm','uncloseai','cloudflare-playground','codex-app-server','auggie','zcode','gemini-cli','kiro','qoder','qwen','github-copilot','opencode','pollinations','zenmux','bytez','vertex'];
const PROVIDER_PREFIXES = {
  nvidia:['nvidia/'], chipotle:['pepper/','chipotle/'], 'duckduckgo-web':['ddgw/'], 'felo-web':['felo/'], theoldllm:['tllm/'], uncloseai:['unc/'],
  'cloudflare-playground':['cfp/'], 'codex-app-server':['cxa/'], auggie:['aug/'], zcode:['zc/'], 'gemini-cli':['gemini-cli/'], kiro:['kr/','kiro/'],
  qoder:['if/','qoder/'], qwen:['qw/','qwen/'], 'github-copilot':['gh/','github-copilot/'], opencode:['opencode/','oc/'], pollinations:['pollinations/','pol/'], zenmux:['zenmux/','zm/'], bytez:['bytez/'], vertex:['vertex/']
};
const providerHealth = new Map();

function providerFromModel(id) {
  const first = String(id || '').split('/')[0].trim().toLowerCase();
  const aliases = { pepper:'chipotle', chipotle:'chipotle', ddgw:'duckduckgo-web', felo:'felo-web', tllm:'theoldllm', unc:'uncloseai', cfp:'cloudflare-playground', cxa:'codex-app-server', aug:'auggie', zc:'zcode', kr:'kiro', kiro:'kiro', if:'qoder', qoder:'qoder', qw:'qwen', qwen:'qwen', gh:'github-copilot', 'github-copilot':'github-copilot', oc:'opencode', opencode:'opencode', pol:'pollinations', pollinations:'pollinations', zm:'zenmux', zenmux:'zenmux' };
  return aliases[first] || first || 'unknown';
}
function providerPrefixes(provider) { return PROVIDER_PREFIXES[provider] || [`${provider}/`]; }

function healthFile() { return config.providerHealthPath; }
function loadHealth() {
  try {
    const raw = JSON.parse(fs.readFileSync(healthFile(), 'utf8'));
    for (const item of Array.isArray(raw) ? raw : []) if (item?.provider) providerHealth.set(String(item.provider), item);
  } catch {}
}
function saveHealth() {
  try {
    fs.mkdirSync(path.dirname(healthFile()), { recursive: true });
    fs.writeFileSync(healthFile(), JSON.stringify([...providerHealth.values()], null, 2), 'utf8');
  } catch {}
}
loadHealth();

function markProvider(provider, patch) {
  providerHealth.set(provider, { provider, ...(providerHealth.get(provider) || {}), ...patch, checkedAt: Date.now() });
  saveHealth();
}
function isFresh(item) { return item && Date.now() - Number(item.checkedAt || 0) < Number(config.providerHealthTtlMs || 1800000); }

async function requestJson(url, options = {}, timeoutMs = 30000) {
  const timeout = withTimeout(timeoutMs);
  try {
    const response = await fetch(url, { ...(options || {}), signal: timeout.controller.signal });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!response.ok) {
      const detail = data?.error || data?.message || data?.detail || data?.raw || text;
      const error = new Error(`HTTP ${response.status}: ${stringifyError(detail).slice(0, 2500)}`);
      error.status = response.status; error.body = data; error.upstream = extractUpstreamTarget(String(detail));
      throw error;
    }
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`OmniRoute request timed out after ${timeoutMs}ms.`);
    throw error;
  } finally { timeout.clear(); }
}

async function models() {
  const key = await resolveOmniRouteApiKey();
  if (!key) throw new Error('OmniRoute Endpoint API key is not configured.');
  return requestJson(`${String(config.omnirouteBase).replace(/\/$/, '')}/models`, { headers: { Authorization: `Bearer ${key}` } }, 15000);
}
function payloadModelEntries(payload) {
  const raw = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  return raw.map((item) => typeof item === 'string' ? { id: item.trim(), raw: { id: item.trim() } } : { id: String(item?.id || item?.model || item?.name || '').trim(), raw: item }).filter((item) => item.id);
}
function payloadModels(payload) { return [...new Set(payloadModelEntries(payload).map((item) => item.id))]; }

function candidateScore(entry, taskType = 'general') {
  const id = entry.id.toLowerCase();
  let score = 0;
  const provider = providerFromModel(entry.id);
  const health = providerHealth.get(provider);
  if (isFresh(health) && health.healthy === true) score += 10000;
  if (isFresh(health) && health.healthy === false) score -= 1000;
  if (provider === 'nvidia') score += 500;
  if (taskType === 'coding' && /(coder|code|devstral|qwen|deepseek|nemotron|gpt)/.test(id)) score += 100;
  if (taskType === 'research' && /(deepseek|qwen|gemini|claude|gpt|nemotron)/.test(id)) score += 90;
  if (taskType === 'planning' && /(thinking|reason|deepseek|qwen|claude|gpt|nemotron)/.test(id)) score += 90;
  if (taskType === 'simple_qa' && /(mini|flash|small|haiku)/.test(id)) score += 60;
  return score - PROVIDER_PRIORITY.indexOf(provider);
}

async function concreteModels(limit = 36, options = {}) {
  const entries = payloadModelEntries(await models()).filter((entry) => isDirectProviderModel(entry.id));
  entries.sort((a, b) => candidateScore(b, options.taskType || 'general') - candidateScore(a, options.taskType || 'general'));
  return entries.slice(0, Math.max(1, Number(limit) || 36));
}
async function concreteModel(options = {}) { return (await concreteModels(1, options))[0]?.id || ''; }

async function chatExact(messages, model, tools) {
  const key = await resolveOmniRouteApiKey();
  if (!key) throw new Error('OmniRoute Endpoint API key is not configured.');
  const selected = String(model || '').trim();
  if (!isDirectProviderModel(selected)) throw new Error(`Invalid direct provider model: ${selected || '(empty)'}`);
  const provider = providerFromModel(selected);
  const data = await requestJson(`${String(config.omnirouteBase).replace(/\/$/, '')}/chat/completions`, {
    method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},
    body:JSON.stringify({ model:selected, messages, stream:false, ...(Array.isArray(tools) && tools.length ? {tools} : {}) })
  }, Number(config.omnirouteTimeoutMs || 120000));
  const text = data?.choices?.[0]?.message?.content || data?.response || data?.text || '';
  const actualModel = String(data?.model || selected);
  const actualProvider = providerFromModel(actualModel);
  if (actualProvider !== provider && actualProvider !== 'unknown') {
    const mismatch = new Error(`OmniRoute provider mismatch: requested ${provider}/${selected} but response identified ${actualProvider}/${actualModel}.`);
    mismatch.status = 502; mismatch.requestedProvider = provider; mismatch.requestedModel = selected; mismatch.actualProvider = actualProvider; mismatch.actualModel = actualModel;
    throw mismatch;
  }
  if (!String(text).trim() && !Array.isArray(data?.choices?.[0]?.message?.tool_calls)) throw new Error('OmniRoute returned no usable content.');
  markProvider(provider, { healthy:true, model:selected, actualModel });
  data.__ultron = { provider, model:selected, actualProvider, actualModel, exact:true };
  return data;
}

async function chat(messages, model, tools, options = {}) {
  const requested = String(model || '').trim();
  let candidates;
  if (requested && isDirectProviderModel(requested)) {
    candidates = [requested, ...(await concreteModels(Number(config.modelCandidateLimit || 36), options)).map((entry) => entry.id).filter((id) => id !== requested)];
  } else {
    candidates = (await concreteModels(Number(config.modelCandidateLimit || 36), options)).map((entry) => entry.id);
  }
  const failures = [];
  const exhausted = new Set();
  for (const selected of [...new Set(candidates)]) {
    const provider = providerFromModel(selected);
    if (exhausted.has(provider)) continue;
    try { return await chatExact(messages, selected, tools); }
    catch (error) {
      const kind = classifyProviderError(error);
      failures.push({ provider, model:selected, kind, status:error?.status || null, message:error?.message || String(error) });
      if (kind === 'CREDENTIALS_OR_ACCESS') { markProvider(provider, { healthy:false, error:error.message }); exhausted.add(provider); continue; }
      if (kind === 'UPSTREAM_OR_NETWORK') continue;
      if (kind === 'MODEL_UNAVAILABLE') continue;
      if (kind === 'QUOTA_OR_RATE_LIMIT') { markProvider(provider, { healthy:false, error:error.message }); exhausted.add(provider); continue; }
      if (kind === 'PAID_MODEL') continue;
      if (error?.requestedProvider && error?.actualProvider && error.requestedProvider !== error.actualProvider) { markProvider(provider, { healthy:false, error:error.message, actualProvider:error.actualProvider }); exhausted.add(provider); continue; }
      if (!isRetryableCandidateError(error)) throw error;
    }
  }
  const finalError = new Error(`OmniRoute could not produce a response after ${failures.length} candidate attempts.`);
  finalError.status = failures.at(-1)?.status || 503; finalError.failures = failures; throw finalError;
}

function providerHealthSnapshot() { return [...providerHealth.values()]; }
async function speak(text) { return requestJson(`${config.parentCore}/api/tts`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,provider:'fish-audio-s2.1-pro-free',format:'mp3',volume:2})},120000); }

module.exports = { requestJson, resolveOmniRouteApiKey, githubReadFile: async (...args) => { const [pathname, ref] = args; if (!config.githubToken) throw new Error('GITHUB_TOKEN is not configured.'); const useRef=ref||config.githubBranch; const url=`https://api.github.com/repos/${encodeURIComponent(config.githubOwner)}/${encodeURIComponent(config.githubRepo)}/contents/${String(pathname||'').split('/').filter(Boolean).map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(useRef)}`; const data=await requestJson(url,{headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',Authorization:`Bearer ${config.githubToken}`}},20000); if(data.type!=='file'||!data.content)throw new Error(`GitHub path is not a readable file: ${pathname}`); return {path:pathname,ref:useRef,sha:data.sha,content:Buffer.from(String(data.content).replace(/\r?\n/g,''),'base64').toString('utf8'),size:Number(data.size)||0}; }, githubList: async (...args) => { const [pathname, ref] = args; if(!config.githubToken) throw new Error('GITHUB_TOKEN is not configured.'); const useRef=ref||config.githubBranch; const suffix=pathname?'/'+String(pathname).split('/').filter(Boolean).map(encodeURIComponent).join('/'):''; return requestJson(`https://api.github.com/repos/${encodeURIComponent(config.githubOwner)}/${encodeURIComponent(config.githubRepo)}/contents${suffix}?ref=${encodeURIComponent(useRef)}`,{headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',Authorization:`Bearer ${config.githubToken}`}},20000); }, models, payloadModels, payloadModelEntries, isRoutingAlias, isDevinModel, isBigPickle, isDirectProviderModel, providerFromModel, classifyProviderError, isProviderCredentialError, isPaidModelError, isRetryableCandidateError, concreteModels, concreteModel, chatExact, chat, providerHealthSnapshot, speak, PROVIDER_PRIORITY };
