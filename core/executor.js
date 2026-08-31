const tools = new Map();

function registerTool(name, handler, metadata = {}) {
  if (!name || typeof handler !== 'function') throw new TypeError('Invalid tool registration.');
  tools.set(name, { handler, metadata });
}

function listTools() {
  return [...tools.entries()].map(([name, tool]) => ({ name, ...tool.metadata }));
}

function openAITools() {
  return [...tools.entries()].map(([name, tool]) => ({
    type: 'function',
    function: {
      name,
      description: String(tool.metadata.description || `Execute ${name}.`),
      parameters: tool.metadata.inputSchema || {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  }));
}

async function execute(name, input = {}, context = {}) {
  const tool = tools.get(name);
  if (!tool) return { ok: false, error: `Tool '${name}' is not registered.` };

  const requiresConfirmation = Boolean(tool.metadata.requiresConfirmation || tool.metadata.destructive);
  if (requiresConfirmation && context.confirmed !== true) {
    return { ok: false, requires_confirmation: true, error: `Tool '${name}' requires confirmation.` };
  }

  try {
    return { ok: true, result: await tool.handler(input, context) };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

module.exports = { registerTool, listTools, openAITools, execute };
