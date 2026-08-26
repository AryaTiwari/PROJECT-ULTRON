const { openAITools, execute } = require('./executor');

async function runModelToolCall(toolCall, context = {}) {
  const fn = toolCall?.function || toolCall;
  const name = fn?.name;
  if (!name) return { ok: false, error: 'Model returned a tool call without a name.' };
  let input = {};
  try { input = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments || '{}') : (fn.arguments || {}); }
  catch { return { ok: false, error: `Invalid tool arguments for ${name}.` }; }
  return execute(name, input, context);
}

module.exports = { openAITools, runModelToolCall };
