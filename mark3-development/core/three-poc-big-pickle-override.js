'use strict';

// Temporary, explicitly opt-in reasoning route for the proven legacy 3-POC
// executor. It never changes global model selection and never falls through to
// personal provider credentials.

const threePoc = require('./three-poc-enrichment-operator');
const modelRouter = require('./model-router');
const omniRoute = require('../../core/omniroute');
const control = require('./command-control-plane');

const INSTALL_FLAG = Symbol.for('ultron.mark3.threePocBigPickleOverride.installed');
const state = {
  active: false,
  requestedModel: null,
  calls: 0,
  successes: 0,
  failures: 0,
  actualModels: new Set(),
};

function enabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.ULTRON_M3_THREE_POC_BIG_PICKLE || ''));
}

function openCodeDisabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.ULTRON_M3_DISABLE_OPENCODE || ''));
}

async function selectRoute() {
  const preferred = [
    'oc/big-pickle',
    'opencode/big-pickle',
    'opencode-zen/big-pickle',
    'big-pickle',
  ];
  try {
    const catalog = await omniRoute.listModels({ force: false });
    for (const id of preferred) if ((catalog || []).includes(id)) return id;
  } catch {}
  return 'oc/big-pickle';
}

async function chatBigPickleOnly({ messages, tools = null, taskType = 'research' } = {}) {
  control.assertAllowed('general-model', { messages });
  if (!Array.isArray(messages) || !messages.length) throw new Error('Big Pickle 3-POC reasoning requires messages.');
  if (openCodeDisabled()) {
    const error = new Error('Big Pickle mode was requested but ULTRON_M3_DISABLE_OPENCODE is enabled.');
    error.code = 'BIG_PICKLE_OPENCODE_DISABLED';
    throw error;
  }

  const model = state.requestedModel || await selectRoute();
  state.requestedModel = model;
  state.calls++;
  try {
    const result = await omniRoute.chat({
      messages,
      model,
      tools,
      taskType,
      timeoutMs: Math.max(15000, Number(process.env.ULTRON_M3_BIG_PICKLE_TIMEOUT_MS || 65000)),
      maxAttempts: Math.max(1, Math.min(3, Number(process.env.ULTRON_M3_BIG_PICKLE_ATTEMPTS || 2))),
      skipModelValidation: true,
    });
    const actual = String(result?.raw?.model || result?.model || model).trim() || model;
    state.successes++;
    state.actualModels.add(actual);
    return {
      ...result,
      model: actual,
      provider: 'opencode',
      transport: 'omniroute',
      routingMode: 'big-pickle-only',
      requestedModel: model,
      personalApiFallbackAllowed: false,
      bigPickleOnly: true,
    };
  } catch (error) {
    state.failures++;
    error.code ||= 'BIG_PICKLE_REASONING_FAILED';
    error.personalApiFallbackAllowed = false;
    throw error;
  }
}

function resetRun() {
  state.active = enabled();
  state.requestedModel = null;
  state.calls = 0;
  state.successes = 0;
  state.failures = 0;
  state.actualModels = new Set();
}

function snapshot() {
  return {
    enabled: enabled(),
    active: state.active,
    requestedModel: state.requestedModel,
    calls: state.calls,
    successes: state.successes,
    failures: state.failures,
    actualModels: [...state.actualModels],
    personalApiFallbacks: 0,
  };
}

function install() {
  if (globalThis[INSTALL_FLAG]) return globalThis[INSTALL_FLAG];

  const baseEnrich = threePoc.enrichWorkbook.bind(threePoc);
  threePoc.enrichWorkbook = async function bigPickleScopedEnrichment(source, options = {}) {
    if (!enabled()) return baseEnrich(source, options);
    resetRun();
    const previous = modelRouter.chatOmniRouteOnly;
    modelRouter.chatOmniRouteOnly = chatBigPickleOnly;
    try {
      return await baseEnrich(source, options);
    } finally {
      modelRouter.chatOmniRouteOnly = previous;
      state.active = false;
    }
  };

  const api = Object.freeze({ installed: true, enabled, snapshot, selectRoute });
  globalThis[INSTALL_FLAG] = api;
  return api;
}

module.exports = { install, enabled, snapshot, selectRoute, chatBigPickleOnly };
