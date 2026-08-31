const { openAITools, execute } = require('./executor');

function normalizeToolCall(call) {
  const fn = call?.function || call || {};
  const name = fn.name;
  let input = {};
  try {
    input = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments || '{}') : (fn.arguments || {});
  } catch {
    return { id: call?.id || `call_${Date.now()}`, name, input: null, error: `Invalid tool arguments for ${name || 'unknown tool'}.` };
  }
  return { id: call?.id || `call_${Date.now()}`, name, input };
}

async function executeToolCalls(toolCalls, context = {}) {
  const normalized = (Array.isArray(toolCalls) ? toolCalls : []).map(normalizeToolCall);
  const results = [];
  for (const call of normalized) {
    if (!call.name) {
      results.push({ id: call.id, name: '', result: { ok: false, error: 'Model returned a tool call without a name.' } });
      continue;
    }
    if (call.input === null) {
      results.push({ id: call.id, name: call.name, result: { ok: false, error: call.error } });
      continue;
    }
    const result = await execute(call.name, call.input, {
      ...context,
      source: context.source || 'model',
    });
    results.push({ id: call.id, name: call.name, result });
  }
  return { normalized, results };
}

function assistantToolMessage(toolCalls) {
  return {
    role: 'assistant',
    content: null,
    tool_calls: toolCalls.map(call => ({
      id: call.id,
      type: 'function',
      function: {
        name: call.name,
        arguments: JSON.stringify(call.input || {}),
      },
    })),
  };
}

function toolResultMessages(results) {
  return results.map(item => ({
    role: 'tool',
    tool_call_id: item.id,
    name: item.name,
    content: JSON.stringify(item.result),
  }));
}

module.exports = {
  getToolSchemas: openAITools,
  executeToolCalls,
  assistantToolMessage,
  toolResultMessages,
};
