// Provider-diverse OmniRoute-only reasoning for the heavy 3-POC workflow.
//
// The normal auto/best-reasoning alias intentionally returns on the first
// successful route. On some OmniRoute installations that repeatedly resolves to
// one provider (for example OpenAI), which gives no provider diversity. This
// scoped wrapper rotates one strong concrete OmniRoute model per reasoning call.
// It never calls direct-provider-router and therefore never consumes personal
// Gemini/OpenAI/etc API keys. Multiple providers are tried only on failure, not
// as an expensive ensemble on every row.

const omniRoute = require('../../core/omniroute');
const registry = require('./provider-registry');
const modelRouter = require('./model-router');
const threePoc = require('./three-poc-enrichment-operator');
const { emit } = require('./events');

const INSTALL_FLAG = Symbol.for('ultron.mark3.threePocOmniRouteDiversity.installed');
const laneCursor = new Map();
let runState = freshState();

function freshState() {
  return {
    calls: 0,
    concreteAttempts: 0,
    concreteSuccesses: 0,
    aliasFallbacks: 0,
    failures: 0,
    providerCounts: {},
    modelCounts: {},
    catalogModels: 0,
    providerPool: [],
  };
}

function csv(name, fallback = '') {
  return String(process.env[name] || fallback)
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function providerOrder() {
  return csv(
    'ULTRON_M3_THREE_POC_OMNI_PROVIDERS',
    'gemini,anthropic,deepseek,qwen,mistral,openai,xai,groq,vertex,zenmux',
  );
}

function provider(model) {
  return registry.providerFromModel(String(model || '').trim());
}

function usableConcreteModel(model) {
  const value = String(model || '').trim();
  if (!value || /^auto(?:\/|$)/i.test(value) || /^no-think(?:\/|$)/i.test(value)) return false;
  if (registry.isBlockedModel(value) || registry.isNonChatModel(value)) return false;
  const p = provider(value);
  return p && p !== 'unknown' && registry.policyAllows(p);
}

function researchScore(model, taskType = 'research') {
  const value = String(model || '').toLowerCase();
  const task = String(taskType || 'research').toLowerCase();
  let score = 0;

  if (/latest|stable/.test(value)) score += 8;
  if (/reason|think|pro|sonnet|opus|r1|large/.test(value)) score += 28;
  if (/gpt[-_/]?5|o3|o4/.test(value)) score += 32;
  if (/gemini[-_/]?3\.(?:5|6)|gemini[-_/]?3/.test(value)) score += 34;
  if (/claude[-_/]?(?:4|opus|sonnet)/.test(value)) score += 34;
  if (/deepseek[-_/]?(?:r1|v3)/.test(value)) score += 28;
  if (/qwen[-_/]?3/.test(value)) score += 24;
  if (/grok[-_/]?(?:4|3)/.test(value)) score += 22;
  if (/mistral.*large/.test(value)) score += 22;
  if (/flash/.test(value)) score += 8;
  if (/mini|lite|small|nano/.test(value)) score -= ['research', 'planning'].includes(task) ? 12 : 2;
  if (/coder|coding|code[-_/]/.test(value) && task !== 'coding') score -= 10;
  if (/preview|experimental|\bexp\b/.test(value)) score -= 5;
  if (/deprecated|legacy|retired|eol/.test(value)) score -= 100;
  return score;
}

function laneFrom(messages = []) {
  const system = String(messages.find((message) => message?.role === 'system')?.content || '').toLowerCase();
  if (system.includes('hiring-authority selector')) return 'selector';
  if (system.includes('independent hiring-responsibility reviewer')) return 'reviewer';
  if (system.includes('exact linkedin employer resolver')) return 'employer';
  if (system.includes('company context analyst')) return 'company-context';
  if (system.includes('profile employer normalizer')) return 'profile-normalizer';
  return 'three-poc-general';
}

function rotate(items, offset) {
  if (!items.length) return [];
  const start = ((offset % items.length) + items.length) % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

function laneOffset(lane) {
  const fixed = {
    selector: 0,
    reviewer: 1,
    employer: 2,
    'company-context': 3,
    'profile-normalizer': 4,
  };
  return Number(fixed[lane] ?? 0);
}

async function diversePool(taskType = 'research') {
  let models = [];
  try { models = await omniRoute.listModels({ force: false }); } catch {}
  const concrete = [...new Set(models.map(String).map((value) => value.trim()).filter(usableConcreteModel))];
  runState.catalogModels = concrete.length;

  const grouped = new Map();
  for (const model of concrete) {
    const p = provider(model);
    if (!grouped.has(p)) grouped.set(p, []);
    grouped.get(p).push(model);
  }

  const order = providerOrder();
  const remaining = [...grouped.keys()].filter((p) => !order.includes(p)).sort();
  const providers = [...order, ...remaining].filter((p) => grouped.has(p));
  const pool = [];
  for (const p of providers) {
    const best = [...grouped.get(p)].sort((a, b) => researchScore(b, taskType) - researchScore(a, taskType) || a.localeCompare(b))[0];
    if (best) pool.push({ provider: p, model: best });
  }
  runState.providerPool = pool.map((item) => item.provider);
  return pool;
}

function increment(target, key) {
  if (!key) return;
  target[key] = Number(target[key] || 0) + 1;
}

async function diversifiedChat(originalChat, { messages, model = 'auto/best-reasoning', tools = null, taskType = 'research' } = {}) {
  require('./command-control-plane').assertAllowed('general-model', { messages });
  runState.calls++;

  const lane = laneFrom(messages);
  const pool = await diversePool(taskType);
  if (!pool.length) {
    runState.aliasFallbacks++;
    return originalChat({ messages, model, tools, taskType });
  }

  const cursor = Number(laneCursor.get(lane) || 0);
  laneCursor.set(lane, cursor + 1);
  const ordered = rotate(pool, laneOffset(lane) + cursor);
  const maxModels = Math.max(1, Math.min(4, Number(process.env.ULTRON_M3_THREE_POC_OMNI_ATTEMPTS || 3)));
  const timeoutMs = Math.max(10000, Number(process.env.ULTRON_M3_THREE_POC_OMNI_TIMEOUT_MS || 50000));
  let lastError = null;

  for (const candidate of ordered.slice(0, maxModels)) {
    runState.concreteAttempts++;
    const started = Date.now();
    emit('model_candidate_started', {
      model: candidate.model,
      provider: candidate.provider,
      candidateNumber: runState.concreteAttempts,
      timeoutMs,
      nativeRouting: true,
      omniRouteOnly: true,
      diversified: true,
      lane,
    });
    try {
      const result = await omniRoute.chat({
        messages,
        model: candidate.model,
        tools,
        taskType,
        timeoutMs,
        maxAttempts: 1,
        skipModelValidation: true,
      });
      const actualModel = String(result?.raw?.model || result?.model || candidate.model).trim();
      const actualProvider = provider(actualModel) || candidate.provider;
      if (!usableConcreteModel(actualModel)) throw new Error(`OmniRoute diversified reasoning returned an ineligible model: ${actualModel}`);

      runState.concreteSuccesses++;
      increment(runState.providerCounts, actualProvider);
      increment(runState.modelCounts, actualModel);
      registry.recordSuccess(actualModel);
      emit('model_candidate_succeeded', {
        model: actualModel,
        provider: actualProvider,
        durationMs: Date.now() - started,
        nativeRouting: true,
        omniRouteOnly: true,
        diversified: true,
        lane,
      });
      return {
        ...result,
        model: actualModel,
        provider: actualProvider,
        transport: 'omniroute',
        routingMode: 'omniroute-only',
        personalApiFallbackAllowed: false,
        diversifiedOmniRoute: true,
        reasoningLane: lane,
      };
    } catch (error) {
      lastError = error;
      runState.failures++;
      emit('model_candidate_failed', {
        model: candidate.model,
        provider: candidate.provider,
        message: String(error?.message || error).slice(0, 500),
        durationMs: Date.now() - started,
        nativeRouting: true,
        omniRouteOnly: true,
        diversified: true,
        lane,
      });
      registry.recordFailure(candidate.model, 'UPSTREAM', error?.message || String(error));
    }
  }

  // Stay inside OmniRoute. Alias fallback is only used after the provider-diverse
  // concrete pool could not complete the call; it can never invoke personal keys.
  runState.aliasFallbacks++;
  try {
    return await originalChat({ messages, model, tools, taskType });
  } catch (error) {
    if (lastError && !error.cause) error.cause = lastError;
    throw error;
  }
}

function startRun() {
  runState = freshState();
  return stats();
}

function stats() {
  return {
    ...runState,
    providerCounts: { ...runState.providerCounts },
    modelCounts: { ...runState.modelCounts },
    providerPool: [...runState.providerPool],
    personalApiFallbacks: 0,
  };
}

function install() {
  if (globalThis[INSTALL_FLAG]) return globalThis[INSTALL_FLAG];

  const originalEnrichWorkbook = threePoc.enrichWorkbook.bind(threePoc);
  const originalFormatResult = threePoc.formatResult.bind(threePoc);

  threePoc.enrichWorkbook = async function diverseOmniRouteThreePocRun(...args) {
    startRun();
    const previous = modelRouter.chatOmniRouteOnly;
    const boundOriginal = previous.bind(modelRouter);
    modelRouter.chatOmniRouteOnly = (request = {}) => diversifiedChat(boundOriginal, request);
    try {
      const result = await originalEnrichWorkbook(...args);
      return { ...result, omniRouteDiversity: stats() };
    } finally {
      modelRouter.chatOmniRouteOnly = previous;
    }
  };

  threePoc.formatResult = function diversityFormatResult(result) {
    const base = originalFormatResult(result);
    const s = result?.omniRouteDiversity;
    if (!s) return base;
    const providers = Object.entries(s.providerCounts || {}).map(([name, count]) => `${name}:${count}`).join(', ') || 'none';
    const pool = (s.providerPool || []).join(', ') || 'none';
    return `${base} OmniRoute diversity: ${s.concreteSuccesses}/${s.calls} diversified reasoning calls completed (${s.concreteAttempts} concrete attempts, ${s.aliasFallbacks} alias fallbacks); providers used [${providers}]; available provider pool [${pool}]. Personal-API fallbacks: 0.`;
  };

  const api = Object.freeze({ startRun, stats, diversePool, researchScore, laneFrom, usableConcreteModel });
  globalThis[INSTALL_FLAG] = api;
  return api;
}

module.exports = {
  install,
  startRun,
  stats,
  diversePool,
  researchScore,
  laneFrom,
  usableConcreteModel,
};
