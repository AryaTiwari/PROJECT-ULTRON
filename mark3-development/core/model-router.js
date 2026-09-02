const omniRoute = require('../../core/omniroute');

const BLOCKED_FREE_MODELS = new Set([
  'big-pickle',
  'mimo-v2.5-free',
  'hy3-free',
  'nemotron-3-ultra-free',
  'nemotron-3.5-lightning-free',
  'x-preview-f-free',
  'muse-spark-1.2-contributor-free',
]);
const MODEL_COOLDOWN_MS = Number(process.env.ULTRON_M3_MODEL_COOLDOWN_MS || 10 * 60 * 1000);
const PROVIDER_ACCESS_COOLDOWN_MS = Number(process.env.ULTRON_M3_PROVIDER_ACCESS_COOLDOWN_MS || 10 * 60 * 1000);
const PROVIDER_RATE_COOLDOWN_MS = Number(process.env.ULTRON_M3_PROVIDER_RATE_COOLDOWN_MS || 90 * 1000);
const MAX_CANDIDATES = Math.max(4, Number(process.env.ULTRON_M3_ROUTER_MAX_CANDIDATES || 16));

const modelCooldowns = new Map();
const providerCooldowns = new Map();

function normalizeModel(model) {
  return omniRoute.normalizeModelId ? omniRoute.normalizeModelId(model) : String(model || '').trim();
}

function isOpenCodeModel(model) {
  const value = normalizeModel(model).toLowerCase();
  return value === 'opencode'
    || value.startsWith('opencode/')
    || value.startsWith('opencode-go/')
    || value.startsWith('oc/')
    || value.includes('big-pickle')
    || value.includes('big_pickle')
    || value.includes('big pickle')
    || BLOCKED_FREE_MODELS.has(value);
}

function isNvidiaModel(model) {
  return normalizeModel(model).toLowerCase().startsWith('nvidia/');
}

function isDevinModel(model) {
  const value = normalizeModel(model).toLowerCase();
  return /(^|[\\/_-])(dva|devin|agentic|bridge)([\\/_-]|$)/i.test(value);
}

function isRoutingAlias(model) {
  const value = normalizeModel(model).toLowerCase();
  return !value || /^auto(?:\/|$)/.test(value) || /^no-think(?:\/|$)/.test(value);
}

function isBlockedModel(model) {
  return !normalizeModel(model) || isRoutingAlias(model) || isOpenCodeModel(model) || isNvidiaModel(model) || isDevinModel(model);
}

function normalizeRequestedModel(model) {
  const value = normalizeModel(model);
  return !value || isRoutingAlias(value) || isBlockedModel(value) ? 'auto' : value;
}

function providerFromModel(model) {
  const first = normalizeModel(model).split('/')[0].trim().toLowerCase();
  const aliases = {
    pepper: 'chipotle',
    chipotle: 'chipotle',
    ddgw: 'duckduckgo-web',
    felo: 'felo-web',
    tllm: 'theoldllm',
    unc: 'uncloseai',
    cfp: 'cloudflare-playground',
    cxa: 'codex-app-server',
    aug: 'auggie',
    zc: 'zcode',
    kr: 'kiro',
    if: 'qoder',
    qw: 'qwen',
    gh: 'github-copilot',
  };
  return aliases[first] || first || 'unknown';
}

function classifyProviderError(error) {
  const status = Number(error?.status || 0);
  const text = `${error?.message || ''} ${error?.raw || error?.body || ''}`.toLowerCase();
  if (status === 402 || /payment_required|payment required|billing_error|paid[- ]?only/.test(text)) return 'PAID_MODEL';
  if ([401, 403].includes(status) || /missing api key|invalid_api_key|authentication failed|no active credentials|forbidden|permission denied/.test(text)) return 'ACCESS';
  if (status === 429 || /quota|rate limit|too many requests|exhausted|anti-abuse/.test(text)) return 'RATE_LIMIT';
  if ([404, 410].includes(status) || /not available in the active live catalog|model.*not.*found|model.*does not exist|end[- ]of[- ]life|\beol\b/.test(text)) return 'MODEL_UNAVAILABLE';
  if (status === 400 && /model|provider|route|unsupported|tools?/.test(text)) return 'BAD_ROUTE';
  if ([408, 425, 500, 502, 503, 504].includes(status) || /timed out|fetch failed|econnrefused|gateway|upstream/.test(text)) return 'UPSTREAM';
  return 'UNKNOWN';
}

function recoverable(error) {
  return classifyProviderError(error) !== 'UNKNOWN';
}

function activeCooldown(map, key) {
  const until = Number(map.get(key) || 0);
  if (!until || until <= Date.now()) {
    if (until) map.delete(key);
    return false;
  }
  return true;
}

function markFailure(model, error) {
  const kind = classifyProviderError(error);
  const provider = providerFromModel(model);
  if (kind === 'ACCESS') providerCooldowns.set(provider, Date.now() + PROVIDER_ACCESS_COOLDOWN_MS);
  else if (kind === 'RATE_LIMIT') providerCooldowns.set(provider, Date.now() + PROVIDER_RATE_COOLDOWN_MS);
  else if (['MODEL_UNAVAILABLE', 'PAID_MODEL', 'BAD_ROUTE'].includes(kind)) modelCooldowns.set(model, Date.now() + MODEL_COOLDOWN_MS);
  else if (kind === 'UPSTREAM') modelCooldowns.set(model, Date.now() + 30 * 1000);
  return kind;
}

function modelAvailableNow(model) {
  return !activeCooldown(modelCooldowns, model) && !activeCooldown(providerCooldowns, providerFromModel(model));
}

function taskOverride(taskType) {
  return normalizeRequestedModel(process.env[`ULTRON_OMNIROUTE_MODEL_${String(taskType || 'general').toUpperCase()}`] || '');
}

function orderedModels(models, requestedModel, taskType) {
  const usable = [...new Set((models || []).map(normalizeModel))]
    .filter((id) => id && !isBlockedModel(id) && modelAvailableNow(id));
  const requested = normalizeRequestedModel(requestedModel);
  const override = taskOverride(taskType);
  const explicit = [];
  if (requested !== 'auto' && usable.includes(requested)) explicit.push(requested);
  if (override !== 'auto' && usable.includes(override) && !explicit.includes(override)) explicit.push(override);

  const byProvider = new Map();
  for (const model of usable) {
    if (explicit.includes(model)) continue;
    const provider = providerFromModel(model);
    if (!byProvider.has(provider)) byProvider.set(provider, []);
    byProvider.get(provider).push(model);
  }

  const providerOrder = [
    'chipotle', 'duckduckgo-web', 'felo-web', 'theoldllm', 'uncloseai',
    'cloudflare-playground', 'codex-app-server', 'auggie', 'zcode',
    'gemini-cli', 'kiro', 'qoder', 'qwen', 'github-copilot', 'pollinations',
    'zenmux', 'bytez', 'vertex', 'groq', 'mistral', 'deepseek', 'gemini',
    'openai', 'anthropic', 'xai',
  ];
  const providers = [...providerOrder.filter((p) => byProvider.has(p)), ...[...byProvider.keys()].filter((p) => !providerOrder.includes(p))];
  const interleaved = [];
  let index = 0;
  while (interleaved.length < usable.length) {
    let added = false;
    for (const provider of providers) {
      const model = byProvider.get(provider)?.[index];
      if (model) { interleaved.push(model); added = true; }
    }
    if (!added) break;
    index += 1;
  }
  return [...explicit, ...interleaved].slice(0, MAX_CANDIDATES);
}

async function listUsableModels({ force = false } = {}) {
  const models = await omniRoute.listModels({ force });
  return [...new Set((models || []).map(normalizeModel))].filter((id) => id && !isBlockedModel(id));
}

async function candidateModels(requestedModel = 'auto', taskType = 'general', { force = false, exclude = [] } = {}) {
  const models = await listUsableModels({ force });
  const excluded = new Set(exclude);
  return orderedModels(models, requestedModel, taskType).filter((model) => !excluded.has(model));
}

function aggregateFailure(failures) {
  const compact = failures.slice(-8).map(({ model, kind, message }) => `${model} [${kind}]: ${message}`).join(' | ');
  const error = new Error(`OmniRoute could not find a usable Mark 3 inference route after ${failures.length} candidate attempt(s).${compact ? ` ${compact}` : ''}`);
  error.status = 502;
  error.failures = failures;
  return error;
}

async function chat({ messages, model = 'auto', tools = null, taskType = 'general' } = {}) {
  if (!Array.isArray(messages) || !messages.length) throw new Error('Mark 3 model request requires messages.');
  const attempted = [];
  const failures = [];

  for (let pass = 0; pass < 2; pass += 1) {
    const candidates = await candidateModels(model, taskType, { force: pass === 1, exclude: attempted });
    for (const candidate of candidates) {
      attempted.push(candidate);
      try {
        const result = await omniRoute.chat({ messages, model: candidate, tools, taskType });
        const actual = normalizeModel(result?.model || candidate);
        if (isBlockedModel(actual)) throw Object.assign(new Error(`OmniRoute returned a blocked Mark 3 model: ${actual}`), { status: 502 });
        modelCooldowns.delete(candidate);
        providerCooldowns.delete(providerFromModel(candidate));
        return { ...result, model: actual || candidate, provider: providerFromModel(actual || candidate), transport: 'omniroute' };
      } catch (error) {
        const kind = markFailure(candidate, error);
        failures.push({ model: candidate, provider: providerFromModel(candidate), kind, status: Number(error?.status || 0), message: String(error?.message || error).slice(0, 500) });
        if (!recoverable(error)) throw error;
      }
    }
    omniRoute.clearCache?.();
  }
  throw aggregateFailure(failures);
}

async function streamChat({ messages, model = 'auto', tools = null, taskType = 'general', onDelta, firstTokenTimeoutMs = null } = {}) {
  if (typeof onDelta !== 'function') throw new Error('Mark 3 streaming requires an onDelta callback.');
  const attempted = [];
  const failures = [];

  for (let pass = 0; pass < 2; pass += 1) {
    const candidates = await candidateModels(model, taskType, { force: pass === 1, exclude: attempted });
    for (const candidate of candidates) {
      attempted.push(candidate);
      let emitted = false;
      try {
        const result = await omniRoute.streamChat({
          messages,
          model: candidate,
          tools,
          taskType,
          firstTokenTimeoutMs,
          onDelta: (delta, meta) => { emitted = true; onDelta(delta, meta); },
        });
        const actual = normalizeModel(result?.model || candidate);
        if (isBlockedModel(actual)) throw Object.assign(new Error(`OmniRoute returned a blocked Mark 3 model: ${actual}`), { status: 502 });
        modelCooldowns.delete(candidate);
        providerCooldowns.delete(providerFromModel(candidate));
        return { ...result, model: actual || candidate, provider: providerFromModel(actual || candidate), transport: 'omniroute' };
      } catch (error) {
        if (emitted) throw error;
        const kind = markFailure(candidate, error);
        failures.push({ model: candidate, provider: providerFromModel(candidate), kind, status: Number(error?.status || 0), message: String(error?.message || error).slice(0, 500) });
        if (!recoverable(error)) throw error;
      }
    }
    omniRoute.clearCache?.();
  }
  throw aggregateFailure(failures);
}

async function health() {
  const base = await omniRoute.health();
  let usable = [];
  let catalogError = null;
  try { usable = await listUsableModels({ force: true }); } catch (error) { catalogError = error.message; }
  return {
    ok: Boolean(base.ok && usable.length),
    mode: 'omniroute',
    endpoint: base.endpoint,
    authenticated: base.authenticated,
    modelCount: base.modelCount,
    usableModelCount: usable.length,
    catalogSample: usable.slice(0, 12),
    latencyMs: base.latencyMs,
    catalogError,
    blocked: { openCode: true, bigPickle: true, nvidiaInference: true, devinFromAssistantChat: true },
    quarantinedModels: [...modelCooldowns.keys()].filter((key) => activeCooldown(modelCooldowns, key)).length,
    quarantinedProviders: [...providerCooldowns.keys()].filter((key) => activeCooldown(providerCooldowns, key)).length,
    error: base.error || null,
  };
}

module.exports = {
  chat,
  streamChat,
  health,
  listUsableModels,
  candidateModels,
  isRoutingAlias,
  isOpenCodeModel,
  isNvidiaModel,
  isDevinModel,
  isBlockedModel,
  normalizeRequestedModel,
  providerFromModel,
  classifyProviderError,
};
