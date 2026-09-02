const { config } = require('./config');
const direct = require('./direct-model-router');
const openCode = require('./opencode-router');
const omniRoute = require('./omniroute');

function isOpenCodeModel(model) {
  const value = String(model || '').trim().toLowerCase();
  return value.startsWith('opencode/') || value.startsWith('opencode-go/') || value.startsWith('oc/') || value.includes('hy3-free') || value.includes('big-pickle') || value.includes('big_pickle') || value.includes('big pickle');
}
function isOmniRouteModel(model) { return String(model || '').trim().toLowerCase().startsWith('omniroute/'); }
function qualitySensitiveTask(taskType) { return ['coding', 'research', 'planning'].includes(String(taskType || '').toLowerCase()); }

async function chat({ messages, model, tools = null, taskType = 'general' } = {}) {
  if (!Array.isArray(messages) || !messages.length) throw new Error('Model request requires messages.');
  const requestedModel = model || config.router.model || 'auto';
  if (isOpenCodeModel(requestedModel)) throw new Error(`OpenCode/Big Pickle model is disabled in Mark 3: ${requestedModel}`);
  const mode = 'omniroute';
  return omniRoute.chat({ messages, model: isOmniRouteModel(requestedModel) ? requestedModel : requestedModel, taskType, tools });
}

async function streamChat({ messages, model, tools = null, taskType = 'general', onDelta } = {}) {
  if (typeof onDelta !== 'function') throw new Error('Streaming requires an onDelta callback.');
  const requestedModel = model || config.router.model || 'auto';
  if (isOpenCodeModel(requestedModel)) throw new Error(`OpenCode/Big Pickle model is disabled in Mark 3: ${requestedModel}`);
  return omniRoute.streamChat({
    messages,
    model: requestedModel,
    taskType,
    tools,
    onDelta,
    firstTokenTimeoutMs: qualitySensitiveTask(taskType)
      ? Number(process.env.ULTRON_STREAM_FIRST_TOKEN_TIMEOUT_COMPLEX_MS || 12000)
      : Number(process.env.ULTRON_STREAM_FIRST_TOKEN_TIMEOUT_MS || 15000),
  });
}

async function health() {
  const omni = await omniRoute.health();
  const directHealth = await direct.health();
  return {
    ok: omni.ok || directHealth.anyConfigured,
    mode: omni.ok ? 'omniroute' : 'none',
    omniroute: omni,
    opencode: { ok: false, disabled: true },
    direct: directHealth,
  };
}

module.exports = { chat, streamChat, health, isOmniRouteModel, chatViaOmniRoute: omniRoute.chat };
