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

async function resolveOpenRouterApiKey() {
  if (config.openRouterApiKey) return config.openRouterApiKey;
  const env = readParentEnv('OPENROUTER_API_KEY');
  if (env) return env;
  try { return String((await loadCredentials()).OPENROUTER_API_KEY || '').trim(); } catch { return ''; }
}

function withTimeout(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, clear: () => clearTimeout(timer) };
}

function stringifyError(value) { if (value == null) return ''; if (typeof value === 'string') return value; try { return JSON.stringify(value); } catch { return String(value); } }

async function requestJson(url, options, timeoutMs = 30000) {
  const timeout = withTimeout(timeoutMs);
  try {
    const response = await fetch(url, { ...(options || {}), signal: timeout.controller.signal });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!response.ok) {
      const detail = data?.error || data?.message || data?.detail || data?.raw || text;
      const error = new Error(`HTTP ${response.status}: ${stringifyError(detail).slice(0, 2500)}`);
      error.status = response.status; error.body = data;
      throw error;
    }
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`OpenRouter request timed out after ${timeoutMs}ms.`);
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
  return requestJson(`https://api.github.com/repos/${encodeURIComponent(config.githubOwner)}/${encodeURIComponent(config.githubRepo)}/contents${suffix}?ref=${encodeURIComponent(useRef)}`, { headers: githubHeaders() }, 20000);
}

async function models() {
  const key = await resolveOpenRouterApiKey();
  if (!key) throw new Error('OpenRouter API key is not configured.');
  return requestJson(config.openRouterBase + '/models', { headers: { Authorization: 'Bearer ' + key } }, 20000);
}

function payloadModelEntries(payload) {
  const raw = Array.isArray(payload?.data) ? payload.data : [];
  return raw.map((item) => typeof item === 'string' ? { id: item.trim(), raw: { id: item.trim() } } : { id: String(item?.id || '').trim(), raw: item }).filter((item) => item.id);
}
function payloadModels(payload) { return payloadModelEntries(payload).map((item) => item.id); }
function modelPricing(entry) {
  const p = entry?.raw?.pricing || {};
  return { prompt: Number(p.prompt || 0), completion: Number(p.completion || 0), request: Number(p.request || 0), image: Number(p.image || 0), webSearch: Number(p.web_search || 0), reasoning: Number(p.internal_reasoning || 0) };
}
function isFreeModelEntry(entry) { const p = modelPricing(entry); return [p.prompt, p.completion, p.request].every((v) => Number.isFinite(v) && v === 0); }
function isRoutingAlias(id) { const value = String(id || '').trim().toLowerCase(); return value === 'openrouter/free' || value === 'openrouter/auto'; }
function isDevinModel(id) { return /(^|[\\/_-])(dva|devin|agentic|bridge)([\\/_-]|$)/i.test(String(id || '')); }
function isBigPickle(id) { return /big[-_ ]?pickle/i.test(String(id || '')); }
function isDirectProviderModel(id) { const value = String(id || '').trim(); return Boolean(value.includes('/') && !isRoutingAlias(value) && !isDevinModel(value) && !isBigPickle(value)); }
function providerFromModel(id) { const value = String(id || '').trim(); return value.includes('/') ? value.split('/')[0].toLowerCase() : 'unknown'; }
function classifyProviderError(error) {
  const status = Number(error?.status || 0); const text = `${error?.message || ''} ${stringifyError(error?.body || '')}`.toLowerCase();
  if (status === 402 || /payment_required|insufficient credits|billing/.test(text)) return 'PAID_OR_BILLING';
  if ([401,403].includes(status) || /invalid api key|authentication|unauthorized|forbidden/.test(text)) return 'CREDENTIALS_OR_ACCESS';
  if (status === 404 || /model.*not.*found|model.*does not exist|unknown model/.test(text)) return 'MODEL_UNAVAILABLE';
  if (status === 429 || /quota|rate limit|too many requests/.test(text)) return 'QUOTA_OR_RATE_LIMIT';
  if (status >= 500 || /upstream|gateway|timed out|fetch failed|connect/.test(text)) return 'UPSTREAM_OR_NETWORK';
  return 'UNKNOWN';
}
function isProviderCredentialError(error) { return classifyProviderError(error) === 'CREDENTIALS_OR_ACCESS'; }
function isPaidModelError(error) { return classifyProviderError(error) === 'PAID_OR_BILLING'; }
function isRetryableCandidateError(error) { return ['PAID_OR_BILLING','MODEL_UNAVAILABLE','QUOTA_OR_RATE_LIMIT','UPSTREAM_OR_NETWORK'].includes(classifyProviderError(error)); }

const PROVIDER_PRIORITY = ['nvidia','openai','anthropic','google','qwen','deepseek','meta-llama','mistralai','z-ai','moonshotai'];
const providerHealth = new Map();

function modelScore(entry, taskType = 'general') {
  const id = entry.id.toLowerCase(); const free = isFreeModelEntry(entry); let score = free ? 1000 : 100;
  if (taskType === 'coding' && /(coder|code|devstral|qwen|deepseek|gpt)/.test(id)) score += 80;
  if (taskType === 'research' && /(deepseek|qwen|gemini|claude|gpt)/.test(id)) score += 70;
  if (taskType === 'planning' && /(reason|thinking|deepseek|qwen|claude|gpt)/.test(id)) score += 70;
  if (taskType === 'simple_qa' && /(mini|flash|small|haiku)/.test(id)) score += 50;
  if (Array.isArray(entry.raw?.supported_parameters) && entry.raw.supported_parameters.includes('tools')) score += 30;
  if (Number(entry.raw?.context_length) >= 100000) score += 20;
  const p = PROVIDER_PRIORITY.indexOf(providerFromModel(entry.id)); if (p >= 0) score += Math.max(0, 40 - p * 4);
  return score;
}

async function concreteModels(limit = 24, options = {}) {
  const entries = payloadModelEntries(await models()).filter((entry) => isDirectProviderModel(entry.id));
  const eligible = config.freeOnly ? entries.filter(isFreeModelEntry) : entries;
  eligible.sort((a,b) => modelScore(b, options.taskType || 'general') - modelScore(a, options.taskType || 'general'));
  return eligible.slice(0, Math.max(1, Number(limit) || 24));
}
async function concreteModel(options = {}) { return (await concreteModels(1, options))[0]?.id || 'openrouter/free'; }

async function chatExact(messages, model, tools) {
  const key = await resolveOpenRouterApiKey(); if (!key) throw new Error('OpenRouter API key is not configured.');
  const selected = String(model || '').trim() || (config.freeOnly ? 'openrouter/free' : 'openrouter/free');
  const body = { model: selected, messages, stream: false }; if (Array.isArray(tools) && tools.length) body.tools = tools;
  const data = await requestJson(config.openRouterBase + '/chat/completions', { method:'POST', headers:{'Content-Type':'application/json',Authorization:'Bearer '+key}, body:JSON.stringify(body) }, 120000);
  data.__ultron = { provider:'openrouter', model:selected, actualModel:data?.model || selected, exact:true }; return data;
}

async function chat(messages, model, tools, options = {}) {
  const key = await resolveOpenRouterApiKey(); if (!key) throw new Error('OpenRouter API key is not configured.');
  const requested = String(model || '').trim();
  if (requested && isDirectProviderModel(requested)) {
    try { return await chatExact(messages, requested, tools); } catch (error) { if (!isRetryableCandidateError(error)) throw error; }
  }
  const candidates = await concreteModels(Math.max(12, config.modelCandidateLimit || 12), options);
  if (!candidates.length) throw new Error('OpenRouter returned no eligible models.');
  const ids = candidates.map((entry) => entry.id); const failures = [];
  try {
    const body = { model: ids[0], models: ids, messages, stream:false }; if (Array.isArray(tools) && tools.length) body.tools = tools;
    const data = await requestJson(config.openRouterBase + '/chat/completions', { method:'POST', headers:{'Content-Type':'application/json',Authorization:'Bearer '+key}, body:JSON.stringify(body) }, 120000);
    data.__ultron = { provider:'openrouter', model:ids[0], actualModel:data?.model || ids[0], fallbackChain:ids }; return data;
  } catch (error) {
    failures.push({model:ids[0],kind:classifyProviderError(error),message:error.message});
    for (const entry of candidates.slice(1)) {
      try { return await chatExact(messages, entry.id, tools); }
      catch (candidateError) { failures.push({model:entry.id,kind:classifyProviderError(candidateError),message:candidateError.message}); }
    }
    const finalError = new Error(`OpenRouter could not produce a response after ${failures.length} model attempts.`); finalError.status=error?.status||503; finalError.failures=failures; throw finalError;
  }
}

async function streamChat(messages, model, tools, onDelta, options = {}) {
  const key = await resolveOpenRouterApiKey(); if (!key) throw new Error('OpenRouter API key is not configured.');
  const selected = String(model || '').trim() || 'openrouter/free';
  const body = { model:selected, messages, stream:true }; if (Array.isArray(tools) && tools.length) body.tools=tools;
  const timeout=withTimeout(120000);
  try {
    const response=await fetch(config.openRouterBase+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify(body),signal:timeout.controller.signal});
    if(!response.ok){const text=await response.text();const error=new Error(`HTTP ${response.status}: ${text.slice(0,2000)}`);error.status=response.status;throw error;}
    if(!response.body)throw new Error('OpenRouter streaming response has no body.');
    const reader=response.body.getReader();const decoder=new TextDecoder();let buffer='';let final='';let actualModel=selected;
    while(true){const{done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const lines=buffer.split('\n');buffer=lines.pop()||'';for(const line of lines){const trimmed=line.trim();if(!trimmed.startsWith('data:'))continue;const payload=trimmed.slice(5).trim();if(payload==='[DONE]')continue;try{const json=JSON.parse(payload);actualModel=json?.model||actualModel;const delta=json?.choices?.[0]?.delta?.content;if(typeof delta==='string'&&delta){final+=delta;onDelta(delta,{model:actualModel,provider:'openrouter'});}}catch{}}}
    return {choices:[{message:{role:'assistant',content:final}}],model:actualModel,__ultron:{provider:'openrouter',model:selected,actualModel}};
  } finally { timeout.clear(); }
}

function providerHealthSnapshot(){return [...providerHealth.entries()].map(([provider,state])=>({provider,...state}));}
async function speak(text){return requestJson(config.parentCore+'/api/tts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,provider:'fish-audio-s2.1-pro-free',format:'mp3',volume:2})},120000);}

module.exports={requestJson,resolveOpenRouterApiKey,githubReadFile,githubList,models,payloadModels,payloadModelEntries,modelPricing,isFreeModelEntry,isRoutingAlias,isDevinModel,isBigPickle,isDirectProviderModel,providerFromModel,classifyProviderError,isProviderCredentialError,isPaidModelError,isRetryableCandidateError,concreteModels,concreteModel,chatExact,chat,streamChat,providerHealthSnapshot,speak,PROVIDER_PRIORITY};
