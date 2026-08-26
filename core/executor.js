const registry = new Map();

function registerTool(name, handler, metadata = {}) {
  if (!name || typeof handler !== 'function') throw new TypeError('Invalid tool registration.');
  registry.set(name, { handler, metadata });
}

function listTools() {
  return [...registry.entries()].map(([name, tool]) => ({ name, ...tool.metadata }));
}

async function execute(name, input = {}, context = {}) {
  const tool = registry.get(name);
  if (!tool) {
    return { ok: false, error: `Tool '${name}' is not registered.` };
  }

  const destructive = Boolean(tool.metadata.destructive);
  const confirmationRequired = Boolean(tool.metadata.confirmationRequired || destructive);

  if (confirmationRequired && context.confirmed !== true) {
    return {
      ok: false,
      requires_confirmation: true,
      error: `Tool '${name}' requires confirmation before execution.`,
    };
  }

  try {
    const result = await tool.handler(input, context);
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

module.exports = { registerTool, listTools, execute };
