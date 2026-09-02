const { config } = require('./config');
const direct = require('./direct-model-router');

// Mark 3 uses the proven Mark 2 direct-provider inference path only.
// OpenCode and OmniRoute are deliberately not reachable from chat inference.
function normalizeRequestedModel(model) {
  const value = String(model || '').trim();
  const lower = value.toLowerCase();
  if (!value || /^auto(?:\/|$)/.test(lower) || /^omniroute\//.test(lower)) return 'auto';
  if (lower.startsWith('opencode/') || lower.startsWith('opencode-go/') || lower.startsWith('oc/') || lower.includes('hy3-free') || lower.includes('big-pickle') || lower.includes('big_pickle') || lower.includes('big pickle')) {
    return 'auto';
  }
  return value;
}

async function chat({ messages, model = 'auto', tools = null, taskType = 'general' } = {}) {
  if (!Array.isArray(messages) || !messages.length) throw new Error('Model request requires messages.');
  return direct.directChat({ messages, model: normalizeRequestedModel(model), tools });
}

async function streamChat({ messages, model = 'auto', tools = null, taskType = 'general', onDelta } = {}) {
  if (typeof onDelta !== 'function') throw new Error('Streaming requires an onDelta callback.');
  const result = await chat({ messages, model, tools, taskType });
  onDelta(result.content, { model: result.model, provider: result.provider, finishReason: 'stop', fallback: false });
  return result;
}

async function health() {
  const directHealth = await direct.health();
  return { ok: directHealth.anyConfigured, mode: 'direct', direct: directHealth, opencode: { ok: false, disabled: true }, omniroute: { ok: false, disabled: true } };
}

module.exports = {
  chat,
  streamChat,
  health,
  isOmniRouteModel: () => false,
  chatViaOmniRoute: async () => { throw new Error('OmniRoute inference is disabled in Mark 3.'); },
};
