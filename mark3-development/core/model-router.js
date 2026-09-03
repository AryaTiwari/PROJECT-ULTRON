const omniRoute = require('../../core/omniroute');
const registry = require('./provider-registry');
const direct = require('./direct-provider-router');
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
  return direct.providerForModel(model) === 'nvidia' || normalizeModel(model).toLowerCase().startsWith('nvidia/');
}

function isDevinModel(model) {
  return /(^|[\\/_-])(dva|devin|agentic|bridge)([\\/_-]|$)/i.test(normalizeModel(model));
}

function isBlockedModel(model) {
  const value = normalizeModel(model);
  return !value || isRoutingAlias(value) || isOpenCodeModel(value) || isDevinModel(value) || registry.isBlockedModel(value);
}

function normalizeRequestedModel(model) {
  const value = normalizeModel(model);
  return !value || isRoutingAlias(value) || isBlockedModel(value) ? 'auto' : value;
}

function providerFromModel(model) {
  return direct.providerForModel(normalizeModel(model)) || registry.providerFromModel(normalizeModel(model));
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
  if (!known) return true;
  if (known.tier !== 'experimental') return true;
  return /^(1|true|yes|on)$/i.test(String(process.env.ULTRON_M3_ALLOW_EXPERIMENTAL_PROVIDERS || ''));
}

function classifyProviderError(error) {
  const status = Number(error?.status || 0);
  const text = `${error?.message || ''} ${error?.raw || error?.body || ''}`.toLowerCase();
  if (/resource_pressure|resource pressure/.test(text)) return 'RESOURCE_PRESSURE';
  if (status === 402 || /payment_required|payment required|billing_error|paid[- ]?only/.test(text)) return 'PAID_MODEL';
  if ([401, 403].includes(status) || /missing api key|invalid_api_key|authentication failed|no active credentials|forbidden|permission denied|not configured.*token|not configured\.?$/.test(text)) return 'ACCESS';
  if (status === 429 || /quota|rate limit|too many requests|exhausted|anti-abuse/.test(text)) return 'RATE_LIMIT';
  if ([404, 410].includes(status) || /not available in the active live catalog|model.*not.*found|model.*does not exist|end[- ]of[- ]life|\beol\b/.test(text)) return 'MODEL_UNAVAILABLE';
  if (status === 400 && /model|provider|route|unsupported|thread creation|tools?/.test(text)) return 'BAD_ROUTE';
  if ([408, 425, 500, 502, 503, 504].includes(status) || /timed out|aborterror|aborted|fetch failed|econnrefused|gateway|upstream|spawn .*enoent|spawn einval|executable doesn't exist|transport is not configured/.test(text)) return 'UPSTREAM';
  return 'UNKNOWN';
}

function recoverable(error) {
  return classifyProviderError(error) !== 'UNKNOWN';
}

function candidateTimeout(taskType) {
  return ['coding', 'research', 'planning'].includes(String(taskType || '').toLowerCase()) ? HEAVY_CANDIDATE_TIMEOUT_MS : GENERAL_CANDIDATE_TIMEOUT_MS;
}

function nativeTimeout(taskType) {
  return ['coding', 'research', 'planning'].includes(String(taskType || '').toLowerCase()) ? NATIVE_HEAVY_ROUTE_TIMEOUT_MS : NATIVE_ROUTE_TIMEOUT_MS;
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
  const error = new Error('OmniRoute fallback is under critical resource pressure. Direct providers were unavailable or exhausted before the fallback gateway was tried.');
  error.status = 503;
  error.code = 'resource_pressure';
  error.cause = original;
  error.failures = failures;
  return error;
}

function failureRow(model, provider, error, extra = {}) {
  return { model, provider, kind: classifyProviderError(error), status: Number(error?.status || 0), message: String(error?.message || error).slice(0, 500), ...extra };
}

async function runDirectChat(messages, tools, taskType, failures) {
  const candidates = await direct.candidates(taskType);
  let number = 0;
  for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
    number += 1;
    const provider = direct.providerForModel(candidate);
    if (!nativeProviderAllowed(provider)) continue;
    const started = Date.now();
    const timeoutMs = direct.timeoutFor(taskType);
    emit('model_candidate_started', { model: candidate, provider, candidateNumber: number, timeoutMs, directRouting: true });
    try {
      const result = await direct.chat({ messages, model: candidate, tools, taskType, timeoutMs });
      registry.recordSuccess(candidate);
      emit('model_candidate_succeeded', { model: result.model || candidate, provider, durationMs: Date.now() - started, candidateNumber: number, directRouting: true });
      return { ...result, model: result.model || candidate, provider, transport: 'direct', routingMode: 'direct-primary' };
    } catch (error) {
      const failure = failureRow(candidate, provider, error, { directRouting: true });
      failures.push(failure);
      registry.recordFailure(candidate, failure.kind, error?.message || String(error));
      emit('model_candidate_failed', { ...failure, durationMs: Date.now() - started, candidateNumber: number });
    }
  }
  return null;
}

async function runDirectStream(messages, tools, taskType, onDelta, firstTokenTimeoutMs, failures) {
  const candidates = await direct.candidates(taskType);
  let number = 0;
  for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
    number += 1;
    const provider = direct.providerForModel(candidate);
    if (!nativeProviderAllowed(provider)) continue;
    const started = Date.now();
    let emitted = false;
    emit('model_candidate_started', { model: candidate, provider, candidateNumber: number, timeoutMs: firstTokenTimeoutMs || null, directRouting: true, streaming: true });
    try {
      const result = await direct.streamChat({
        messages,
        model: candidate,
        tools,
        taskType,
        firstTokenTimeoutMs,
        onDelta: (delta, meta) => { emitted = true; onDelta(delta, meta); },
      });
      registry.recordSuccess(candidate);
      emit('model_candidate_succeeded', { model: result.model || candidate, provider, durationMs: Date.now() - started, candidateNumber: number, directRouting: true, streaming: true });
      return { ...result, model: result.model || candidate, provider, transport: 'direct', routingMode: 'direct-primary' };
    } catch (error) {
      if (emitted) throw error;
      const failure = failureRow(candidate, provider, error, { directRouting: true });
      failures.push(failure);
      registry.recordFailure(candidate, failure.kind, error?.message || String(error));
      emit('model_candidate_failed', { ...failure, durationMs: Date.now() - started, candidateNumber: number, streaming: true });
    }
  }
  return null;
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
      return { ...result, model: resolved.model, provider: resolved.provider, transport: 'omniroute', routingMode: 'omniroute-fallback' };
    } catch (error) {
      const kind = classifyProviderError(error);
      const failure = failureRow(alias, 'omniroute-auto', error, { nativeRouting: true });
      failures.push(failure);
      emit('model_candidate_failed', { ...failure, durationMs: Date.now() - started, candidateNumber: number });
      if (kind === 'RESOURCE_PRESSURE') throw gatewayPressureError(error, failures);
      if (!recoverable(error)) throw error;
    }
  }
  return null;
}

async function omniCatalog({ force = false } = {}) {
  try { return await omniRoute.listModels({ force }); } catch { return []; }
}

async function listUsableModels({ force = false } = {}) {
  const [directModels, omniModels] = await Promise.all([direct.allConfiguredModels(), omniCatalog({ force })]);
  return [...new Set([...directModels, ...(omniModels || []).map(normalizeModel)])]
    .filter((model) => model && !isBlockedModel(model) && registry.policyAllows(providerFromModel(model)));
}

async function listNativeEligibleModels({ force = false } = {}) {
  const [directModels, omniModels] = await Promise.all([direct.allConfiguredModels(), omniCatalog({ force })]);
  return [...new Set([...directModels, ...(omniModels || []).map(normalizeModel)])]
    .filter((model) => model && !isBlockedModel(model) && nativeProviderAllowed(providerFromModel(model)));
}

async function candidateModels(requestedModel = 'auto', taskType = 'general', { force = false, exclude = [] } = {}) {
  const catalog = await listUsableModels({ force });
  return registry.buildCandidates(catalog, normalizeRequestedModel(requestedModel), taskType, { maxCandidates: MAX_CANDIDATES, exclude });
}

async function chatExact({ messages, model, tools = null, taskType = 'general', timeoutMs = null } = {}) {
  if (!Array.isArray(messages) || !messages.length) throw new Error('Exact model request requires messages.');
  const requested = normalizeModel(model);
  if (!requested || isRoutingAlias(requested) || isBlockedModel(requested)) throw new Error(`Model is not eligible for exact Mark 3 inference: ${requested || model}`);
  const provider = providerFromModel(requested);
  if (!nativeProviderAllowed(provider)) throw new Error(`Provider is disabled for exact Mark 3 inference: ${provider}`);
  const budget = Math.max(5000, Number(timeoutMs || (direct.isDirectModel(requested) ? direct.timeoutFor(taskType) : nativeTimeout(taskType))));
  const started = Date.now();
  emit('model_candidate_started', { model: requested, provider, timeoutMs: budget, exactRouting: true, directRouting: direct.isDirectModel(requested) });
  try {
    const result = direct.isDirectModel(requested)
      ? await direct.chat({ messages, model: requested, tools, taskType, timeoutMs: budget })
      : await omniRoute.chat({ messages, model: requested, tools, taskType, timeoutMs: budget, maxAttempts: 1, skipModelValidation: true });
    const actual = concreteResultModel(result, requested);
    if (isBlockedModel(actual)) throw new Error(`Exact inference returned a blocked/non-chat model: ${actual}`);
    const actualProvider = providerFromModel(actual);
    if (!nativeProviderAllowed(actualProvider)) throw new Error(`Exact inference returned a disabled provider '${actualProvider}' via ${actual}.`);
    registry.recordSuccess(actual);
    emit('model_candidate_succeeded', { model: actual, provider: actualProvider, durationMs: Date.now() - started, exactRouting: true, transport: result.transport || 'omniroute' });
    return { ...result, model: actual, provider: actualProvider, transport: result.transport || 'omniroute', routingMode: direct.isDirectModel(requested) ? 'direct-exact' : 'omniroute-exact' };
  } catch (error) {
    const kind = classifyProviderError(error);
    emit('model_candidate_failed', { model: requested, provider, kind, status: Number(error?.status || 0), message: String(error?.message || error).slice(0, 500), durationMs: Date.now() - started, exactRouting: true });
    registry.recordFailure(requested, kind, error?.message || String(error));
    if (!direct.isDirectModel(requested) && kind === 'RESOURCE_PRESSURE') throw gatewayPressureError(error, [{ model: requested, provider, kind, exactRouting: true }]);
    throw error;
  }
}

async function streamExact({ messages, model, tools = null, taskType = 'general', onDelta, firstTokenTimeoutMs = null } = {}) {
  if (!Array.isArray(messages) || !messages.length) throw new Error('Exact streaming request requires messages.');
  if (typeof onDelta !== 'function') throw new Error('Exact streaming request requires an onDelta callback.');
  const requested = normalizeModel(model);
  if (!requested || isRoutingAlias(requested) || isBlockedModel(requested)) throw new Error(`Model is not eligible for exact Mark 3 streaming: ${requested || model}`);
  const provider = providerFromModel(requested);
  if (!nativeProviderAllowed(provider)) throw new Error(`Provider is disabled for exact Mark 3 streaming: ${provider}`);
  const budget = Math.max(3000, Number(firstTokenTimeoutMs || (direct.isDirectModel(requested) ? process.env.ULTRON_M3_DIRECT_FIRST_TOKEN_TIMEOUT_MS || 9000 : nativeTimeout(taskType))));
  const started = Date.now();
  emit('model_candidate_started', { model: requested, provider, timeoutMs: budget, streaming: true, exactRouting: true, directRouting: direct.isDirectModel(requested) });
  try {
    const result = direct.isDirectModel(requested)
      ? await direct.streamChat({ messages, model: requested, tools, taskType, firstTokenTimeoutMs: budget, onDelta })
      : await omniRoute.streamChat({ messages, model: requested, tools, taskType, firstTokenTimeoutMs: budget, skipModelValidation: true, onDelta });
    const actual = concreteResultModel(result, requested);
    if (isBlockedModel(actual)) throw new Error(`Exact streaming returned a blocked/non-chat model: ${actual}`);
    const actualProvider = providerFromModel(actual);
    registry.recordSuccess(actual);
    emit('model_candidate_succeeded', { model: actual, provider: actualProvider, durationMs: Date.now() - started, streaming: true, exactRouting: true, transport: result.transport || 'omniroute' });
    return { ...result, model: actual, provider: actualProvider, transport: result.transport || 'omniroute', routingMode: direct.isDirectModel(requested) ? 'direct-exact' : 'omniroute-exact' };
  } catch (error) {
    const kind = classifyProviderError(error);
    emit('model_candidate_failed', { model: requested, provider, kind, status: Number(error?.status || 0), message: String(error?.message || error).slice(0, 500), durationMs: Date.now() - started, streaming: true, exactRouting: true });
    registry.recordFailure(requested, kind, error?.message || String(error));
    throw error;
  }
}

function aggregateFailure(failures) {
  const directFailures = failures.filter((failure) => failure.directRouting);
  const omniFailures = failures.filter((failure) => failure.nativeRouting || failure.omniRouting);
  const pieces = [];
  if (directFailures.length) pieces.push(`direct providers: ${[...new Set(directFailures.map((f) => `${f.provider}/${f.kind}`))].join(', ')}`);
  if (omniFailures.length) pieces.push(`OmniRoute fallback: ${[...new Set(omniFailures.map((f) => f.kind))].join('/')}`);
  const error = new Error(`No Mark 3 model route completed the request.${pieces.length ? ` ${pieces.join('; ')}.` : ''}`);
  error.status = 502;
  error.failures = failures;
  return error;
}

async function runManagedCandidate(candidate, messages, tools, taskType, timeoutMs) {
  if (direct.isDirectModel(candidate)) return direct.chat({ messages, model: candidate, tools, taskType, timeoutMs });
  return omniRoute.chat({ messages, model: candidate, tools, taskType, timeoutMs, maxAttempts: 1, skipModelValidation: true });
}

async function chat({ messages, model = 'auto', tools = null, taskType = 'general' } = {}) {
  if (!Array.isArray(messages) || !messages.length) throw new Error('Mark 3 model request requires messages.');
  const failures = [];
  const requested = normalizeModel(model);

  if (requested && !isRoutingAlias(requested) && direct.isDirectModel(requested)) {
    return chatExact({ messages, model: requested, tools, taskType });
  }

  if (!requested || isRoutingAlias(requested)) {
    const directResult = await runDirectChat(messages, tools, taskType, failures);
    if (directResult) return directResult;
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
      emit('model_candidate_started', { model: candidate, provider, candidateNumber: attempted.length, timeoutMs, managedFallback: true });
      try {
        const result = await runManagedCandidate(candidate, messages, tools, taskType, timeoutMs);
        const actual = concreteResultModel(result, candidate);
        if (isBlockedModel(actual)) throw new Error(`Model router returned a blocked/non-chat Mark 3 model: ${actual}`);
        registry.recordSuccess(actual);
        const actualProvider = providerFromModel(actual);
        emit('model_candidate_succeeded', { model: actual, provider: actualProvider, durationMs: Date.now() - started, candidateNumber: attempted.length, managedFallback: true });
        return { ...result, model: actual, provider: actualProvider, transport: result.transport || 'omniroute', routingMode: direct.isDirectModel(candidate) ? 'direct-managed' : 'omniroute-managed-fallback' };
      } catch (error) {
        const failure = failureRow(candidate, provider, error, { omniRouting: !direct.isDirectModel(candidate) });
        failures.push(failure);
        emit('model_candidate_failed', { ...failure, durationMs: Date.now() - started, candidateNumber: attempted.length });
        registry.recordFailure(candidate, failure.kind, error?.message || String(error));
        if (!direct.isDirectModel(candidate) && failure.kind === 'RESOURCE_PRESSURE') throw gatewayPressureError(error, failures);
        if (!recoverable(error) && !direct.isDirectModel(candidate)) throw error;
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

  if (requested && !isRoutingAlias(requested) && direct.isDirectModel(requested)) {
    return streamExact({ messages, model: requested, tools, taskType, onDelta, firstTokenTimeoutMs });
  }

  if (!requested || isRoutingAlias(requested)) {
    const directResult = await runDirectStream(messages, tools, taskType, onDelta, firstTokenTimeoutMs, failures);
    if (directResult) return directResult;

    let number = 0;
    const nativeFirstTokenTimeoutMs = firstTokenTimeoutMs || nativeTimeout(taskType);
    for (const alias of nativeAliases(requested || 'auto', taskType)) {
      number += 1;
      const started = Date.now();
      let emitted = false;
      emit('model_candidate_started', { model: alias, provider: 'omniroute-auto', candidateNumber: number, timeoutMs: nativeFirstTokenTimeoutMs, streaming: true, nativeRouting: true });
      try {
        const result = await omniRoute.streamChat({ messages, model: alias, tools, taskType, firstTokenTimeoutMs: nativeFirstTokenTimeoutMs, skipModelValidation: true, onDelta: (delta, meta) => { emitted = true; onDelta(delta, meta); } });
        const resolved = validateNativeResult(result, alias);
        emit('model_candidate_succeeded', { model: resolved.model, provider: resolved.provider, durationMs: Date.now() - started, candidateNumber: number, streaming: true, nativeRouting: true });
        return { ...result, model: resolved.model, provider: resolved.provider, transport: 'omniroute', routingMode: 'omniroute-fallback' };
      } catch (error) {
        if (emitted) throw error;
        const failure = failureRow(alias, 'omniroute-auto', error, { nativeRouting: true });
        failures.push(failure);
        emit('model_candidate_failed', { ...failure, durationMs: Date.now() - started, candidateNumber: number, streaming: true });
        if (failure.kind === 'RESOURCE_PRESSURE') throw gatewayPressureError(error, failures);
        if (!recoverable(error)) throw error;
      }
    }
  }

  // A concrete non-direct model still streams through OmniRoute.
  if (requested && !isRoutingAlias(requested)) {
    return streamExact({ messages, model: requested, tools, taskType, onDelta, firstTokenTimeoutMs });
  }

  throw aggregateFailure(failures);
}

async function health() {
  const directHealth = await direct.health();
  let base = { ok: false, endpoint: null, authenticated: false, modelCount: 0, latencyMs: null, error: null };
  try { base = await omniRoute.health(); } catch (error) { base.error = error.message; }
  let usable = [];
  let nativeEligible = [];
  let catalogError = null;
  try {
    usable = await listUsableModels({ force: true });
    nativeEligible = await listNativeEligibleModels({ force: false });
  } catch (error) { catalogError = error.message; }
  const policy = await registry.snapshot(usable);
  return {
    ok: Boolean(directHealth.configured || base.ok),
    mode: 'direct-first-with-omniroute-fallback',
    primary: directHealth.configured ? 'direct-api' : 'omniroute',
    direct: directHealth,
    omniroute: {
      ok: Boolean(base.ok), endpoint: base.endpoint, authenticated: base.authenticated,
      gatewayModelCount: base.modelCount, latencyMs: base.latencyMs, error: base.error || null,
    },
    eligibleModelCount: usable.length,
    nativeEligibleModelCount: nativeEligible.length,
    catalogSample: nativeEligible.slice(0, 16),
    catalogError,
    maxCandidates: MAX_CANDIDATES,
    policy,
    blocked: { openCode: true, bigPickle: true, nvidiaInference: false, devinFromAssistantChat: true, experimentalConcreteFallbacks: true, nonChatModels: true },
  };
}

async function providerSnapshot() {
  let catalog = [];
  try { catalog = await listUsableModels({ force: true }); } catch {}
  return registry.snapshot(catalog);
}

function clearRoutingCache() { omniRoute.clearCache?.(); }
function resetProviderHealth() { registry.resetTransientHealth?.(); }

module.exports = {
  chat,
  streamChat,
  chatExact,
  streamExact,
  health,
  providerSnapshot,
  clearRoutingCache,
  resetProviderHealth,
  listUsableModels,
  listNativeEligibleModels,
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