const { health } = require('./model-router');
const local = require('./memory/local-store');
const supabase = require('./memory/supabase');
const { listTools } = require('./executor');

async function snapshot(core) {
  const memories = await core.getMemories();
  return {
    generated_at: new Date().toISOString(),
    status: core.status(),
    model_gateway: await health(),
    memory: {
      backend: supabase.available() ? 'supabase+local' : 'local-fallback',
      count: memories.length,
      recent: memories.slice(0, 10),
    },
    model_performance: local.getModelPerformance(25),
    tools: listTools(),
  };
}

module.exports = { snapshot };
