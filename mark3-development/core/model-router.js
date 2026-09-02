const omniRoute = require('../../core/omniroute');
const registry = require('./provider-registry');
const { emit } = require('./events');

const MAX_CANDIDATES = Math.max(2, Number(process.env.ULTRON_M3_ROUTER_MAX_CANDIDATES || 6));
const GENERAL_CANDIDATE_TIMEOUT_MS = Math.max(4000, Number(process.env.ULTRON_M3_CANDIDATE_TIMEOUT_MS || 10000));
const HEAVY_CANDIDATE_TIMEOUT_MS = Math.max(GENERAL_CANDIDATE_TIMEOUT_MS, Number(process.env.ULTRON_M3_HEAVY_CANDIDATE_TIMEOUT_MS || 18000));

function normalizeModel(model) {
  return omniRoute.normalizeModelId ? omniRoute.normalizeModelId(model) : String(model || '').trim();
}

function isRoutingAlias(model) {
  const value = normalizeModel(model).toLowerCase();
  return !value || /^auto(?:\/|$)/.test(value) || /^no-think(?:\/|$)/.test(value);
}

function isOpenCodeModel(model) {
  const value = normalizeModel(model).toLowerCase();
  return value === 'opencode'
    || value.startsWith('opencode/')
    || value.startsWith('opencode-go/')
    || value.startsWith('oc/')
    || /big[-_ ]?pickle/i.test(value)
    || /(mimo-v2\.5-free|hy3-free|nemotron-3-ultra-free|nemotron-3\.5-lightning-free|x-preview-f-free|muse-spark-1\.2-contributor-free)/i.test(value);
}

function isNvidiaModel(model) {
  return normalizeModel(model).toLowerCase().startsWith('nvidia/');
}

function isDevinModel(model) {
  return /(^|[\\/_-])(dva|devin|agentic|bridge)([\\/_-]|$)/i.test(normalizeModel(model));
}

function isBlockedModel(model) {
  const value = normalizeModel(model);
  return !value || isRoutingAlias(value) || isOpenCodeModel(value) || isNvidiaModel(value) || isDevinModel(value) || registry.isBlockedModel(value);
}

function normalizeRequestedModel(model) {
  const value = normalizeModel(model);
  return !value || isRoutingAlias(value) || isBlockedModel(value) ? 'auto' : value;
}

function providerFromModel(model) {
  return registry.providerFromModel(normalizeModel(model));
}

function classifyProviderError(error) {
  const status = Number(error?.status || 0);
  const text = `${error?.message || ''} ${error?.raw || error?.body || ''}`.toLowerCase();
  if (status === 402 || /payment_required|payment required|billing_error|paid[- ]?only/.test(text)) return 'PAID_MODEL';
  if ([401, 403].includes(status) || /missing api key|invalid_api_key|authentication failed|no active credentials|forbidden|permission denied|not configured.*token/.test(text)) return 'ACCESS';
  if (status === 429 || /quota|rate limit|too many requests|exhausted|anti-abuse/.test(text)) return 'RATE_LIMIT';
  if ([404, 410].includes(status) || /not available in the active live catalog|model.*not.*found|model.*does not exist|end[- ]of[- ]life|\beol\b/.test(text)) return 'MODEL_UNAVAILABLE';
  if (status === 400 && /model|provider|route|unsupported|thread creation|tools?/.test(text)) return 'BAD_ROUTE';
  if ([408, 425, 500, 502, 503, 504].includes(status) || /timed out|fetch failed|econnrefused|gateway|upstream|spawn .*enoent|spawn einval|executable doesn't exist|transport is not configured/.test(text)) return 'UPSTREAM';
  return 'UNKNOWN';
}

function recoverable(error) {
  return classifyProviderError(error) !== 'UNKNOWN';
}

function taskOverride(taskType) {
  return normalizeRequestedModel(process.env[`ULTRON_OMNIROUTE_MODEL_${String(taskType || 'general').toUpperCase()}`] || '');
}

function candidateTimeout(taskType) {
  return ['coding', 'research', 'planning'].includes(String(taskType || '').toLowerCase())
    ? HEAVY_CANDIDATE_TIMEOUT_MS
    : GENERAL_CANDIDATE_TIMEOUT_MS;
}

async function listUsableModels({ force = false } = {}) {
  const models = await omniRoute.listModels({ force });
  return [...new Set((models || []).map(normalizeModel))]
    .filter((model) => model && !isBlockedModel(model) && registry.policyAllows(providerFromModel(model)));
}

async function candidateModels(requestedModel = 'auto', taskType = 'general', { force = false, exclude = [] } = {}) {
  const catalog = await listUsableModels({ force });
  const requested = normalizeRequestedModel(requestedModel);
  const override = taskOverride(taskType);
  const preferred = requested !== 'auto' ? requested : override;
  return registry.buildCandidates(catalog, preferred, taskType, {
    maxCandidates: MAX_CANDIDATES,
    exclude,
  });
}

function aggregateFailure(failures) {
  const providerKinds = new Map();
  for (const failure of failures) {
    if (!providerKinds.has(failure.provider)) providerKinds.set(failure.provider, new Set());
    providerKinds.get(failure.provider).add(failure.kind);
  }
  const summary = [...providerKinds.entries()]
    .map(([provider, kinds]) => `${provider}: ${[...kinds].join('/')}`)
    .join(', ');
  const error = new Error(
    failures.length
      ? `No healthy OmniRoute provider completed the request. Tried ${summary}. Browser/CLI experimental routes are disabled by Mark 3; provider details are available at /api/providers.`
      : 'OmniRoute published no eligible Mark 3 chat provider. Add a supported API provider key or inspect /api/providers.',
  );
  error.status = 502;
  error.failures = failures;
  return error;
}

async function runChatCandidate(candidate, messages, tools, taskType, timeoutMs) {
  return omniRoute.chat({
    messages,
    model: candidate,
    tools,
    taskType,
    timeoutMs,
    maxAttempts: 1,
    skipModelValidation: true,
  });
}

async function chat({ messages, model = 'auto', tools = null, taskType = 'general' } = {}) {
  if (!Array.isArray(messages) || !messages.length) throw new Error('Mark 3 model request requires messages.');
  const attempted = [];
  const failures = [];
  const timeoutMs = candidateTimeout(taskType);

  for (let pass = 0; pass < 2; pass += 1) {
    const candidates = await candidateModels(model, taskType, { force: pass === 1, exclude: attempted });
    if (!candidates.length) break;

    for (const candidate of candidates) {
      attempted.push(candidate);
      const provider = providerFromModel(candidate);
      const started = Date.now();
      emit('model_candidate_started', { model: candidate, provider, candidateNumber: attempted.length, timeoutMs });
      try {
        const result = await runChatCandidate(candidate, messages, tools, taskType, timeoutMs);
        const actual = normalizeModel(result?.model || candidate);
        if (isBlockedModel(actual)) {
          const error = new Error(`OmniRoute returned a blocked/non-chat Mark 3 model: ${actual}`);
          error.status = 502;
          throw error;
        }
        registry.recordSuccess(actual || candidate);
        emit('model_candidate_succeeded', {
          model: actual || candidate,
          provider: providerFromModel(actual || candidate),
          durationMs: Date.now() - started,
          candidateNumber: attempted.length,
        });
        return { ...result, model: actual || candidate, provider: providerFromModel(actual || candidate), transport: 'omniroute' };
      } catch (error) {
        const kind = classifyProviderError(error);
        registry.recordFailure(candidate, kind, error?.message || String(error));
        const failure = {
          model: candidate,
          provider,
          kind,
          status: Number(error?.status || 0),
          message: String(error?.message || error).slice(0, 500),
        };
        failures.push(failure);
        emit('model_candidate_failed', { ...failure, durationMs: Date.now() - started, candidateNumber: attempted.length });
        if (!recoverable(error)) throw error;
      }
    }
    omniRoute.clearCache?.();
  }

  throw aggregateFailure(failures);
}

async function streamChat({ messages, model = 'auto', tools = null, taskType = 'general', onDelta, firstTokenTimeoutMs = null } = {}) {
  if (!Array.isArray(messages) || !messages.length) throw new Error('Mark 3 streaming request requires messages.');
  if (typeof onDelta !== 'function') throw new Error('Mark 3 streaming requires an onDelta callback.');
  const attempted = [];
  const failures = [];
  const timeoutMs = firstTokenTimeoutMs || candidateTimeout(taskType);

  for (let pass = 0; pass < 2; pass += 1) {
    const candidates = await candidateModels(model, taskType, { force: pass === 1, exclude: attempted });
    if (!candidates.length) break;

    for (const candidate of candidates) {
      attempted.push(candidate);
      const provider = providerFromModel(candidate);
      const started = Date.now();
      let emitted = false;
      emit('model_candidate_started', { model: candidate, provider, candidateNumber: attempted.length, timeoutMs, streaming: true });
      try {
        const result = await omniRoute.streamChat({
          messages,
          model: candidate,
          tools,
          taskType,
          firstTokenTimeoutMs: timeoutMs,
          skipModelValidation: true,
          onDelta: (delta, meta) => { emitted = true; onDelta(delta, meta); },
        });
        const actual = normalizeModel(result?.model || candidate);
        if (isBlockedModel(actual)) {
          const error = new Error(`OmniRoute returned a blocked/non-chat Mark 3 model: ${actual}`);
          error.status = 502;
          throw error;
        }
        registry.recordSuccess(actual || candidate);
        emit('model_candidate_succeeded', {
          model: actual || candidate,
          provider: providerFromModel(actual || candidate),
          durationMs: Date.now() - started,
          candidateNumber: attempted.length,
          streaming: true,
        });
        return { ...result, model: actual || candidate, provider: providerFromModel(actual || candidate), transport: 'omniroute' };
      } catch (error) {
        if (emitted) throw error;
        const kind = classifyProviderError(error);
        registry.recordFailure(candidate, kind, error?.message || String(error));
        const failure = {
          model: candidate,
          provider,
          kind,
          status: Number(error?.status || 0),
          message: String(error?.message || error).slice(0, 500),
        };
        failures.push(failure);
        emit('model_candidate_failed', { ...failure, durationMs: Date.now() - started, candidateNumber: attempted.length, streaming: true });
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
  try { usable = await listUsableModels({ force: true }); }
  catch (error) { catalogError = error.message; }
  const policy = await registry.snapshot(usable);
  return {
    ok: Boolean(base.ok && usable.length),
    mode: 'managed-omniroute',
    endpoint: base.endpoint,
    authenticated: base.authenticated,
    gatewayModelCount: base.modelCount,
    eligibleChatModelCount: usable.length,
    catalogSample: usable.slice(0, 12),
    latencyMs: base.latencyMs,
    catalogError,
    candidateTimeoutMs: GENERAL_CANDIDATE_TIMEOUT_MS,
    heavyCandidateTimeoutMs: HEAVY_CANDIDATE_TIMEOUT_MS,
    maxCandidates: MAX_CANDIDATES,
    policy,
    blocked: {
      openCode: true,
      bigPickle: true,
      nvidiaInference: true,
      devinFromAssistantChat: true,
      browserAndCliProvidersByDefault: true,
      nonChatModels: true,
    },
    error: base.error || null,
  };
}

async function providerSnapshot() {
  let catalog = [];
  try { catalog = await listUsableModels({ force: true }); } catch {}
  return registry.snapshot(catalog);
}

module.exports = {
  chat,
  streamChat,
  health,
  providerSnapshot,
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
