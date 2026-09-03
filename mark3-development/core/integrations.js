const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const config = require('./config');
const { load: loadCredentials } = require('../../core/credentials/local-store');
const modelRouter = require('./model-router');
const rootVoice = require('../../core/voice');
const windowsVoice = require('./windows-voice');

function readParentEnv(name) {
  try {
    const envPath = path.resolve(config.projectRoot, '.env');
    if (!fs.existsSync(envPath)) return '';
    const line = fs.readFileSync(envPath, 'utf8').split(/\r?\n/).find((entry) => entry.trim().startsWith(`${name}=`));
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

function isRoutingAlias(id) { return modelRouter.isRoutingAlias(id); }
function isDevinModel(id) { return modelRouter.isDevinModel(id); }
function isBigPickle(id) { return /big[-_ ]?pickle/i.test(String(id || '')); }
function isOpenCodeModel(id) { return modelRouter.isOpenCodeModel(id); }
function isNvidiaModel(id) { return modelRouter.isNvidiaModel(id); }
function isDirectProviderModel(id) {
  const value = String(id || '').trim();
  return Boolean(value && !modelRouter.isBlockedModel(value));
}
function providerFromModel(id) { return modelRouter.providerFromModel(id); }
function classifyProviderError(error) { return modelRouter.classifyProviderError(error); }
function isProviderCredentialError(error) { return classifyProviderError(error) === 'ACCESS'; }
function isPaidModelError(error) { return classifyProviderError(error) === 'PAID_MODEL'; }
function isRetryableCandidateError(error) { return classifyProviderError(error) !== 'UNKNOWN'; }

async function models() {
  try {
    const data = await modelRouter.listUsableModels({ force: true });
    return { data: data.map((id) => ({ id })) };
  } catch (error) {
    return { data: [], error: error.message };
  }
}

function payloadModelEntries(payload) {
  const raw = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  return raw
    .map((item) => typeof item === 'string' ? { id: item.trim(), raw: { id: item.trim() } } : { id: String(item?.id || item?.model || item?.name || '').trim(), raw: item })
    .filter((item) => item.id && isDirectProviderModel(item.id));
}
function payloadModels(payload) { return [...new Set(payloadModelEntries(payload).map((item) => item.id))]; }
async function concreteModels(limit = 36) { return payloadModelEntries(await models()).slice(0, Math.max(1, Number(limit) || 36)); }
async function concreteModel() { return (await concreteModels(1))[0]?.id || ''; }
async function selectMark2Model(model = 'auto') { return modelRouter.normalizeRequestedModel(model); }
async function selectNonOpenCodeDirectModel() { return concreteModel(); }
async function resolveModel(requestedModel = 'auto') { return modelRouter.normalizeRequestedModel(requestedModel); }

async function chat(messages, model = 'auto', tools = null, options = {}) {
  return modelRouter.chat({ messages, model, tools, taskType: options.taskType || 'general' });
}
async function streamChat(messages, model = 'auto', tools = null, options = {}) {
  return modelRouter.streamChat({ messages, model, tools, taskType: options.taskType || 'general', onDelta: options.onDelta, firstTokenTimeoutMs: options.firstTokenTimeoutMs });
}
async function chatExact(messages, model, tools = null, options = {}) {
  return modelRouter.chatExact({ messages, model, tools, taskType: options.taskType || 'general', timeoutMs: options.timeoutMs });
}
async function streamExact(messages, model, tools = null, options = {}) {
  return modelRouter.streamExact({ messages, model, tools, taskType: options.taskType || 'general', onDelta: options.onDelta, firstTokenTimeoutMs: options.firstTokenTimeoutMs });
}
async function health() { return modelRouter.health(); }
async function providerHealthSnapshot() { return modelRouter.providerSnapshot(); }

async function speak(text, options = {}) {
  const failures = [];
  try {
    const audio = await rootVoice.speak(text, { ...options, outputDir: config.voiceOutputDir });
    if (audio?.path) return { ...audio, fallback: false };
    if (audio?.reason) throw new Error(audio.reason);
    throw new Error('Primary ULTRON voice returned no audio path.');
  } catch (error) {
    failures.push(`primary: ${error.message}`);
  }

  if (config.voiceFallback === 'windows-sapi') {
    try {
      const audio = await windowsVoice.synthesize(text, { ...options, outputDir: config.voiceOutputDir });
      return { ...audio, primaryError: failures[0] || null };
    } catch (error) {
      failures.push(`windows-sapi: ${error.message}`);
    }
  }

  throw new Error(`ULTRON voice synthesis failed. ${failures.join(' | ')}`);
}

function voiceStatus() {
  let primary = {};
  try { primary = rootVoice.status(); } catch (error) { primary = { configured: false, error: error.message }; }
  return {
    primary,
    fallback: config.voiceFallback,
    outputDir: config.voiceOutputDir,
    referencePath: config.voiceReferencePath,
    referencePresent: fs.existsSync(config.voiceReferencePath),
  };
}

async function requestJson(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...(options || {}), signal: controller.signal });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}: ${text.slice(0, 2500)}`);
      error.status = response.status;
      error.body = data;
      throw error;
    }
    return data;
  } finally { clearTimeout(timer); }
}
const jsonRequest = requestJson;

function githubHeaders() {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(config.githubToken ? { Authorization: `Bearer ${config.githubToken}` } : {}),
  };
}

async function githubReadFile(pathname, ref) {
  if (!config.githubToken) throw new Error('GITHUB_TOKEN is not configured.');
  const useRef = ref || config.githubBranch;
  const encodedPath = String(pathname || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
  const url = `https://api.github.com/repos/${encodeURIComponent(config.githubOwner)}/${encodeURIComponent(config.githubRepo)}/contents/${encodedPath}?ref=${encodeURIComponent(useRef)}`;
  const data = await requestJson(url, { headers: githubHeaders() }, 20000);
  if (data.type !== 'file' || !data.content) throw new Error(`GitHub path is not a readable file: ${pathname}`);
  return { path: pathname, ref: useRef, sha: data.sha, content: Buffer.from(String(data.content).replace(/\r?\n/g, ''), 'base64').toString('utf8'), size: Number(data.size) || 0 };
}

async function githubList(pathname = '', ref) {
  if (!config.githubToken) throw new Error('GITHUB_TOKEN is not configured.');
  const useRef = ref || config.githubBranch;
  const suffix = pathname ? `/${String(pathname).split('/').filter(Boolean).map(encodeURIComponent).join('/')}` : '';
  return requestJson(`https://api.github.com/repos/${encodeURIComponent(config.githubOwner)}/${encodeURIComponent(config.githubRepo)}/contents${suffix}?ref=${encodeURIComponent(useRef)}`, { headers: githubHeaders() }, 20000);
}

function gitText(args) {
  try {
    return String(execFileSync('git', args, { cwd: config.projectRoot, windowsHide: true, encoding: 'utf8', timeout: 8000 }) || '').trim();
  } catch {
    return '';
  }
}

async function githubSelfStatus() {
  const owner = config.githubOwner;
  const repo = config.githubRepo;
  const branch = config.githubBranch;
  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const branchData = await requestJson(`${base}/branches/${encodeURIComponent(branch)}`, { headers: githubHeaders() }, 12000);
  const remoteHead = String(branchData?.commit?.sha || '').trim();
  if (!remoteHead) throw new Error(`GitHub did not return a head commit for ${branch}.`);

  const localHead = gitText(['rev-parse', 'HEAD']);
  const localBranch = gitText(['branch', '--show-current']) || 'detached';
  const dirty = Boolean(gitText(['status', '--porcelain']));
  let relationship = localHead && localHead === remoteHead ? 'identical' : 'different';
  let aheadBy = null;
  let behindBy = null;

  if (localHead && localHead !== remoteHead) {
    try {
      const comparison = await requestJson(`${base}/compare/${encodeURIComponent(localHead)}...${encodeURIComponent(remoteHead)}`, { headers: githubHeaders() }, 12000);
      relationship = String(comparison?.status || relationship);
      aheadBy = Number.isFinite(Number(comparison?.ahead_by)) ? Number(comparison.ahead_by) : null;
      behindBy = Number.isFinite(Number(comparison?.behind_by)) ? Number(comparison.behind_by) : null;
    } catch {}
  }

  const updateAvailable = relationship === 'ahead' || relationship === 'diverged' || (!localHead && Boolean(remoteHead));
  return {
    owner,
    repo,
    branch,
    localHead: localHead || null,
    localBranch,
    remoteHead,
    relationship,
    updateAvailable,
    aheadBy,
    behindBy,
    dirty,
    latest: {
      message: String(branchData?.commit?.commit?.message || '').split(/\r?\n/)[0].trim() || null,
      date: branchData?.commit?.commit?.committer?.date || branchData?.commit?.commit?.author?.date || null,
      url: branchData?.commit?.html_url || null,
    },
  };
}

module.exports = {
  requestJson,
  jsonRequest,
  resolveOmniRouteApiKey,
  githubReadFile,
  githubList,
  githubSelfStatus,
  models,
  payloadModels,
  payloadModelEntries,
  resolveModel,
  isRoutingAlias,
  isDevinModel,
  isBigPickle,
  isOpenCodeModel,
  isNvidiaModel,
  isDirectProviderModel,
  providerFromModel,
  classifyProviderError,
  isProviderCredentialError,
  isPaidModelError,
  isRetryableCandidateError,
  concreteModels,
  concreteModel,
  chatExact,
  streamExact,
  chat,
  streamChat,
  health,
  providerHealthSnapshot,
  speak,
  voiceStatus,
  selectMark2Model,
  selectNonOpenCodeDirectModel,
  PROVIDER_PRIORITY: ['gemini', 'groq', 'deepseek', 'mistral', 'qwen', 'openai', 'anthropic', 'xai', 'vertex', 'zenmux', 'bytez', 'pollinations'],
};
