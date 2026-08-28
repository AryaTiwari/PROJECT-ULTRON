const { config } = require('./config');
const direct = require('./direct-model-router');
const openCode = require('./opencode-router');
const omniRoute = require('./omniroute');

function isOmniRouteModel(model) {
  return String(model || '').trim().toLowerCase().startsWith('omniroute/');
}

async function chat({ messages, model, tools = null, taskType = 'general' } = {}) {
  if (!Array.isArray(messages) || !messages.length) throw new Error('Model request requires messages.');
  const requestedModel = model || config.router.model;
  const mode = String(process.env.ULTRON_MODEL_PROVIDER || 'omniroute').toLowerCase();

  if (isOmniRouteModel(requestedModel)) {
    return omniRoute.chat({ messages, model: requestedModel, taskType, tools });
  }

  if (mode === 'omniroute') {
    return omniRoute.chat({ messages, model: requestedModel, taskType, tools });
  }
  if (mode === 'opencode-server' || mode === 'opencode') {
    return openCode.chat({ messages, model: requestedModel, tools });
  }
  if (mode === 'direct') return direct.directChat({ messages, model: requestedModel, tools });

  if (mode === 'auto') {
    try { return await omniRoute.chat({ messages, model: requestedModel, taskType, tools }); }
    catch (omniError) {
      try { return await openCode.chat({ messages, model: requestedModel, tools }); }
      catch (openCodeError) {
        try { return await direct.directChat({ messages, model: requestedModel, tools }); }
        catch (directError) {
          throw new Error(`OmniRoute, OpenCode and direct routing all failed. OmniRoute: ${omniError.message}. OpenCode: ${openCodeError.message}. Direct: ${directError.message}`);
        }
      }
    }
  }
  throw new Error('No model provider mode is configured. Use omniroute (default), opencode-server, direct, or auto.');
}

async function health() {
  const omni = await omniRoute.health();
  const openCodeHealth = await openCode.health();
  const directHealth = await direct.health();
  return {
    ok: omni.ok || openCodeHealth.ok || directHealth.anyConfigured,
    mode: omni.ok ? 'omniroute' : openCodeHealth.ok ? 'opencode-server' : directHealth.anyConfigured ? 'direct' : 'none',
    omniroute: omni,
    opencode: openCodeHealth,
    direct: directHealth,
  };
}

module.exports = { chat, health, isOmniRouteModel, chatViaOmniRoute: omniRoute.chat };
