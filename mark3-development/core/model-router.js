const { config } = require('./config');
const omniRoute = require('../../core/omniroute');

function isOpenCodeModel(model) {
  const value = String(model || '').trim().toLowerCase();
  return value.startsWith('opencode/') || value.startsWith('opencode-go/') || value.startsWith('oc/') || value.includes('hy3-free') || value.includes('big-pickle') || value.includes('big_pickle') || value.includes('big pickle');
}

function isNvidiaModel(model) {
  return String(model || '').trim().toLowerCase().startsWith('nvidia/');
}

function isRoutingAlias(model) {
  const value = String(model || '').trim().toLowerCase();
  return !value || /^auto(?:\/|$)/.test(value) || /^omniroute\//.test(value) || /^no-think(?:\/|$)/.test(value);
}

function normalizeRequestedModel(model) {
  const value = String(model || '').trim();
  if (!value || isRoutingAlias(value) || isOpenCodeModel(value) || isNvidiaModel(value)) return 'auto';
  return value;
}

async function chat({ messages, model = 'auto', tools = null, taskType = 'general' } = {}) {
  return omniRoute.chat({
    messages,
    model: normalizeRequestedModel(model),
    tools,
    taskType,
  });
}

async function streamChat({ messages, model = 'auto', tools = null, taskType = 'general', onDelta, firstTokenTimeoutMs = null } = {}) {
  return omniRoute.streamChat({
    messages,
    model: normalizeRequestedModel(model),
    tools,
    taskType,
    onDelta,
    firstTokenTimeoutMs,
  });
}

async function health() {
  return omniRoute.health();
}

module.exports = { chat, streamChat, health, isRoutingAlias, isOpenCodeModel, isNvidiaModel, normalizeRequestedModel };
