const omniRoute = require('../../core/omniroute');
const registry = require('./provider-registry');
const { emit } = require('./events');

const MAX_CANDIDATES = Math.max(2, Number(process.env.ULTRON_M3_ROUTER_MAX_CANDIDATES || 6));
const GENERAL_CANDIDATE_TIMEOUT_MS = Math.max(5000, Number(process.env.ULTRON_M3_CANDIDATE_TIMEOUT_MS || 12000));
const HEAVY_CANDIDATE_TIMEOUT_MS = Math.max(GENERAL_CANDIDATE_TIMEOUT_MS, Number(process.env.ULTRON_M3_HEAVY_CANDIDATE_TIMEOUT_MS || 22000));
const NATIVE_ROUTE_TIMEOUT_MS = Math.max(GENERAL_CANDIDATE_TIMEOUT_MS, Number(process.env.ULTRON_M3_NATIVE_ROUTE_TIMEOUT_MS || 30000));
const NATIVE_HEAVY_ROUTE_TIMEOUT_MS = Math.max(NATIVE_ROUTE_TIMEOUT_MS, Number(process.env.ULTRON_M3_NATIVE_HEAVY_ROUTE_TIMEOUT_MS || 45000));

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

function csvEnv(name) {
  return String(process.env[name] || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
}

function nativeProviderAllowed(provider) {
  const normalized = String(provider || '').trim().toLowerCase();
  if (!normalized) return false;
  const denylist = new Set(csvEnv('ULTRON_M3_PROVIDER_DENYLIST'));
  if (denylist.has(normalized)) return false;
  const allowlist = csvEnv('ULTRON_M3_PROVIDER_ALLOWLIST');
  if (allowlist.length) return allowlist.includes(normalized);

  const known = registry.PROVIDERS?.[normalized];
  if (!known) return true; // Native OmniRoute chose it; trust unless explicitly denied.
  if (known.tier !== 'experimental') return true;
  return /^(1|true|yes|on)$/i.test(String(process.env.ULTRON_M3_ALLOW_EXPERIMENTAL_PROVIDERS || ''));
}

function classifyProviderError(error) {
  const status = Number(error?.status || 0);
  const text = `${error?.message || ''} ${error?.raw || error?.body || ''}`.toLowerCase();
  if (/resource_pressure|resource pressure/.test(text)) return 'RESOURCE_PRESSURE';
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

function candidateTimeout(taskType) {
  return ['coding', 'research', 'planning'].includes(String(taskType || '').toLowerCase())
    ? HEAVY_CANDIDATE_TIMEOUT_MS
    : GENERAL_CANDIDATE_TIMEOUT_MS;
}

function nativeTimeout(taskType) {
  return ['coding', 'research', 'planning'].includes(String(taskType || '').toLowerCase())
    ? NATIVE_HEAVY_ROUTE_TIMEOUT_MS
    : NATIVE_ROUTE_TIMEOUT_MS;
}

function nativeAliasForTask(taskType) {
  const task = String(taskType || 'general').toLowerCase();
  if (task === 'coding') return 'auto/best-coding';
  if (task === 'research' || task === 'planning') return 'auto/best-reasoning';
  return 'auto/best-fast';
}

function nativeAliases(requestedModel, taskType) {
  const requested = normalizeModel(requestedModel);
  const primary = isRoutingAlias(requested) && requested && requested !== 'auto' ? requested : nativeAliasForTask(taskType);
  return [...new Set([primary, 'auto', taskType === 'general' || taskType === 'simple_qa' ? 'auto/best-fast' : nativeAliasForTask(taskType)])];
}

function concreteResultModel(result, fallback) {
  const candidates = [result?.raw?.model, result?.model, fallback].map(normalizeModel).filter(Boolean);
  return candidates.find((model) => !isRoutingAlias(model)) || candidates[0] || fallback;
}

function validateNativeResult(result, alias) {
  const actual = concreteResultModel(result, alias);
  if (!isRoutingAlias(actual)) {
    if (isBlockedModel(actual)) {
      const error = new Error(`OmniRoute native routing returned a blocked/non-chat model: ${actual}`);
      error.status = 502;
      throw error;
    }
    const provider = providerFromModel(actual);
    if (!nativeProviderAllowed(provider)) {
      const error = new Error(`OmniRoute native routing selected explicitly disabled provider '${provider}' via ${actual}.`);
      error.status = 502;
      throw error;
    }
    registry.recordSuccess(actual);
    return { model: actual, provider };
  }
  return { model: actual || alias, provider: 'omniroute-auto' };
}

function gatewayPressureError(original, failures = []) {
  const error = new Error('OmniRoute is refusing chat requests because its gateway process is under critical resource pressure. Model/provider fallback cannot fix a process-wide admission rejection.');
  error.status = 503;
  error.code = 'resource_pressure';
  error.cause = original;
  error.failures = failures;
  return error;
}

async function runNativeChat(messages, requestedModel, tools, taskType, failures) {
  const timeoutMs = nativeTimeout(taskType);
  let number = 0;
  for (const alias of nativeAliases(requestedModel, taskType)) {
    number += 1;
    const started = Date.now();
    emit('model_candidate_started', { model: alias, provider: 'omniroute-auto', candidateNumber: number, timeoutMs, nativeRouting: true });
    try {
      const result = await omniRoute.chat({ messages, model: alias, tools, taskType, timeoutMs, maxAttempts: 1, skipModelValidation: true });
      const resolved = validateNativeResult(result, alias);
      emit('model_candidate_succeeded', { model: resolved.model, provider: resolved.provider, durationMs: Date.now() - started, candidateNumber: number, nativeRouting: true });
      return { ...result, model: resolved.model, provider: resolved.provider, transport: 'omniroute', routingMode: 'native-auto' };
    } catch (error) {
      const kind = classifyProviderError(error);
      const failure = { model: alias, provider: 'omniroute-auto', kind, status: Number(error?.status || 0), message: String(error?.message || error).slice(0, 500), nativeRouting: true };
      failures.push(failure);
      emit('model_candidate_failed', { ...failure, durationMs: Date.now() - started, candidateNumber: number });
      if (kind === 'RESOURCE_PRESSURE') throw gatewayPressureError(error, failures);
      if (!recoverable(error)) throw error;
    }
  }
  return null;
}

async function listUsableModels({ force = false } = {}) {
  const models = await omniRoute.listModels({ force });
  return [...new Set((models || []).map(normalizeModel))]
    .filter((model) => model && !isBlockedModel(model) && registry.policyAllows(providerFromModel(model)));
}

async function candidateModels(requestedModel = 'auto', taskType = 'general', { force = false, exclude = [] } = {}) {
  const catalog = await listUsableModels({ force });
  return registry.buildCandidates(catalog, normalizeRequestedModel(requestedModel), taskType, { maxCandidates: MAX_CANDIDATES, exclude });
}

function aggregateFailure(failures) {
  const native = failures.filter((f) => f.nativeRouting);
  const managed = failures.filter((f) => !f.nativeRouting);
  const managedProviders = new Map();
  for (const failure of managed) {
    if (!managedProviders.has(failure.provider)) managedProviders.set(failure.provider, new Set());
    managedProviders.get(failure.provider).add(failure.kind);
  }
  const pieces = [];
  if (native.length) pieces.push(`native OmniRoute auto routing: ${[...new Set(native.map((f) => f.kind))].join('/')}`);
  if (managedProviders.size) pieces.push(`managed fallback: ${[...managedProviders.entries()].map(([provider, kinds]) => `${provider} ${[...kinds].join('/')}`).join(', ')}`);
  const error = new Error(`No OmniRoute route completed the request.${pieces.length ? ` ${pieces.join('; ')}.` : ''}`);
  error.status = 502;
  error.failures = failures;
  return error;
}

async function runManagedCandidate(candidate, messages, tools, taskType, timeoutMs) {
  return omniRoute.chat({ messages, model: candidate, tools, taskType, timeoutMs, maxAttempts: 1, skipModelValidation: true });
}

async function chat({ messages, model = 'auto', tools = null, taskType = 'general' } = {}) {
  if (!Array.isArray(messages) || !messages.length) throw new Error('Mark 3 model request requires messages.');
  const failures = [];
  const requested = normalizeModel(model);

  if (!requested || isRoutingAlias(requested)) {
    const native = await runNativeChat(messages, requested || 'auto', tools, taskType, failures);
    if (native) return native;
  }

  const attempted = [];
  const timeoutMs = candidateTimeout(taskType);
  for (let pass = 0; pass < 2; pass += 1) {
    const candidates = await candidateModels(requested || 'auto', taskType, { force: pass === 1, exclude: attempted });
    if (!candidates.length) break;
    for (const candidate of candidates) {
      attempted.push(candidate);
      const provider = providerFromModel(candidate);
      const started = Date.now();
      emit('model_candidate_started', { model: candidate, provider, candidateNumber: attempted.length, timeoutMs, nativeRouting: false });
      try {
        const result = await runManagedCandidate(candidate, messages, tools, taskType, timeoutMs);
        const actual = concreteResultModel(result, candidate);
        if (isBlockedModel(actual)) {
          const error = new Error(`OmniRoute returned a blocked/non-chat Mark 3 model: ${actual}`);
          error.status = 502;
          throw error;
        }
        registry.recordSuccess(actual);
        const actualProvider = providerFromModel(actual);
        emit('model_candidate_succeeded', { model: actual, provider: actualProvider, durationMs: Date.now() - started, candidateNumber: attempted.length, nativeRouting: false });
        return { ...result, model: actual, provider: actualProvider, transport: 'omniroute', routingMode: 'managed-fallback' };
      } catch (error) {
        const kind = classifyProviderError(error);
        const failure = { model: candidate, provider, kind, status: Number(error?.status || 0), message: String(error?.message || error).slice(0, 500), nativeRouting: false };
        failures.push(failure);
        emit('model_candidate_failed', { ...failure, durationMs: Date.now() - started, candidateNumber: attempted.length });
        if (kind === 'RESOURCE_PRESSURE') throw gatewayPressureError(error, failures);
        registry.recordFailure(candidate, kind, error?.message || String(error));
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
  const failures = [];
  const requested = normalizeModel(model);
  const managedTimeoutMs = firstTokenTimeoutMs || candidateTimeout(taskType);
  const nativeFirstTokenTimeoutMs = firstTokenTimeoutMs || nativeTimeout(taskType);

  if (!requested || isRoutingAlias(requested)) {
    let number = 0;
    for (const alias of nativeAliases(requested || 'auto', taskType)) {
      number += 1;
      const started = Date.now();
      let emitted = false;
      emit('model_candidate_started', { model: alias, provider: 'omniroute-auto', candidateNumber: number, timeoutMs: nativeFirstTokenTimeoutMs, streaming: true, nativeRouting: true });
      try {
        const result = await omniRoute.streamChat({
          messages,
          model: alias,
          tools,
          taskType,
          firstTokenTimeoutMs: nativeFirstTokenTimeoutMs,
          skipModelValidation: true,
          onDelta: (delta, meta) => { emitted = true; onDelta(delta, meta); },
        });
        const resolved = validateNativeResult(result, alias);
        emit('model_candidate_succeeded', { model: resolved.model, provider: resolved.provider, durationMs: Date.now() - started, candidateNumber: number, streaming: true, nativeRouting: true });
        return { ...result, model: resolved.model, provider: resolved.provider, transport: 'omniroute', routingMode: 'native-auto' };
      } catch (error) {
        if (emitted) throw error;
        const kind = classifyProviderError(error);
        const failure = { model: alias, provider: 'omniroute-auto', kind, status: Number(error?.status || 0), message: String(error?.message || error).slice(0, 500), nativeRouting: true };
        failures.push(failure);
        emit('model_candidate_failed', { ...failure, durationMs: Date.now() - started, candidateNumber: number, streaming: true });
        if (kind === 'RESOURCE_PRESSURE') throw gatewayPressureError(error, failures);
        if (!recoverable(error)) throw error;
      }
    }
  }

  const attempted = [];
  for (let pass = 0; pass < 2; pass += 1) {
    const candidates = await candidateModels(requested || 'auto', taskType, { force: pass === 1, exclude: attempted });
    if (!candidates.length) break;
    for (const candidate of candidates) {
      attempted.push(candidate);
      const provider = providerFromModel(candidate);
      const started = Date.now();
      let emitted = false;
      emit('model_candidate_started', { model: candidate, provider, candidateNumber: attempted.length, timeoutMs: managedTimeoutMs, streaming: true, nativeRouting: false });
      try {
        const result = await omniRoute.streamChat({
          messages,
          model: candidate,
          tools,
          taskType,
          firstTokenTimeoutMs: managedTimeoutMs,
          skipModelValidation: true,
          onDelta: (delta, meta) => { emitted = true; onDelta(delta, meta); },
        });
        const actual = concreteResultModel(result, candidate);
        if (isBlockedModel(actual)) {
          const error = new Error(`OmniRoute returned a blocked/non-chat Mark 3 model: ${actual}`);
          error.status = 502;
          throw error;
        }
        registry.recordSuccess(actual);
        const actualProvider = providerFromModel(actual);
        emit('model_candidate_succeeded', { model: actual, provider: actualProvider, durationMs: Date.now() - started, candidateNumber: attempted.length, streaming: true, nativeRouting: false });
        return { ...result, model: actual, provider: actualProvider, transport: 'omniroute', routingMode: 'managed-fallback' };
      } catch (error) {
        if (emitted) throw error;
        const kind = classifyProviderError(error);
        const failure = { model: candidate, provider, kind, status: Number(error?.status || 0), message: String(error?.message || error).slice(0, 500), nativeRouting: false };
        failures.push(failure);
        emit('model_candidate_failed', { ...failure, durationMs: Date.now() - started, candidateNumber: attempted.length, streaming: true });
        if (kind === 'RESOURCE_PRESSURE') throw gatewayPressureError(error, failures);
        registry.recordFailure(candidate, kind, error?.message || String(error));
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
    ok: Boolean(base.ok),
    mode: 'native-omniroute-with-managed-fallback',
    endpoint: base.endpoint,
    authenticated: base.authenticated,
    gatewayModelCount: base.modelCount,
    eligibleFallbackModelCount: usable.length,
    nativeAliases: ['auto/best-fast', 'auto/best-reasoning', 'auto/best-coding'],
    catalogSample: usable.slice(0, 12),
    latencyMs: base.latencyMs,
    catalogError,
    candidateTimeoutMs: GENERAL_CANDIDATE_TIMEOUT_MS,
    heavyCandidateTimeoutMs: HEAVY_CANDIDATE_TIMEOUT_MS,
    nativeRouteTimeoutMs: NATIVE_ROUTE_TIMEOUT_MS,
    nativeHeavyRouteTimeoutMs: NATIVE_HEAVY_ROUTE_TIMEOUT_MS,
    maxCandidates: MAX_CANDIDATES,
    policy,
    blocked: { openCode: true, bigPickle: true, nvidiaInference: true, devinFromAssistantChat: true, experimentalConcreteFallbacks: true, nonChatModels: true },
    error: base.error || null,
  };
}

async function providerSnapshot() {
  let catalog = [];
  try { catalog = await listUsableModels({ force: true }); } catch {}
  return registry.snapshot(catalog);
}

function clearRoutingCache() {
  omniRoute.clearCache?.();
}

function resetProviderHealth() {
  registry.resetTransientHealth?.();
}

module.exports = {
  chat,
  streamChat,
  health,
  providerSnapshot,
  clearRoutingCache,
  resetProviderHealth,
  listUsableModels,
  candidateModels,
  nativeAliasForTask,
  isRoutingAlias,
  isOpenCodeModel,
  isNvidiaModel,
  isDevinModel,
  isBlockedModel,
  normalizeRequestedModel,
  providerFromModel,
  nativeProviderAllowed,
  classifyProviderError,
};