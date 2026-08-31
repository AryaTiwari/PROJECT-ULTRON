const { listModels } = require('./omniroute');
const { bestLearnedModel, summarize, rank } = require('./model-router-stats');
const local = require('./memory/local-store');
const { config } = require('./config');

let snapshot = { fetchedAt: 0, models: [], providers: {}, count: 0 };

function providerForModel(model) {
  const id = String(model || '').toLowerCase();
  if (id.startsWith('nvidia/')) return 'nvidia';
  if (id.startsWith('pollinations/') || id.startsWith('pol/')) return 'pollinations';
  if (id.startsWith('openrouter/')) return 'openrouter';
  if (id.startsWith('google/')) return 'google';
  if (id.startsWith('openai/')) return 'openai';
  if (id.startsWith('anthropic/')) return 'anthropic';
  if (id.startsWith('meta/')) return 'meta';
  if (id.startsWith('deepseek/')) return 'deepseek';
  if (id.startsWith('groq/')) return 'groq';
  return 'other';
}

function group(models) {
  const providers = {};
  for (const model of models) {
    const provider = providerForModel(model);
    if (!providers[provider]) providers[provider] = { count: 0, models: [] };
    providers[provider].count += 1;
    if (providers[provider].models.length < 200) providers[provider].models.push(model);
  }
  return providers;
}

async function refresh(force = false) {
  const ttl = Number(process.env.ULTRON_MODEL_INTELLIGENCE_CACHE_MS || 300000);
  if (!force && snapshot.fetchedAt && Date.now() - snapshot.fetchedAt < ttl) return snapshot;
  const models = await listModels({ force });
  snapshot = { fetchedAt: Date.now(), models, providers: group(models), count: models.length };
  return snapshot;
}

function performance(taskType = null) {
  const events = local.getModelPerformance(1000);
  return rank(events, taskType).slice(0, 20);
}

async function catalog(input = {}) {
  const current = await refresh(Boolean(input.refresh));
  const taskType = input.taskType ? String(input.taskType) : null;
  const query = String(input.query || '').trim().toLowerCase();
  let models = current.models;
  if (query) models = models.filter(model => model.toLowerCase().includes(query));
  const limit = Math.max(1, Math.min(Number(input.limit) || 100, 500));
  return {
    ok: true,
    currentModel: config.router.model,
    configuredProviderMode: process.env.ULTRON_MODEL_PROVIDER || 'omniroute',
    count: current.count,
    providers: Object.fromEntries(Object.entries(current.providers).map(([name, value]) => [name, { count: value.count, sample: value.models.slice(0, 25) }])),
    models: models.slice(0, limit),
    performance: performance(taskType),
    bestLearnedModel: taskType ? bestLearnedModel(taskType) : null,
    fetchedAt: current.fetchedAt,
  };
}

async function context(taskType = null) {
  const data = await catalog({ taskType, limit: 60 });
  const providerSummary = Object.entries(data.providers).map(([name, value]) => `${name}: ${value.count}`).join(', ');
  const performanceSummary = data.performance.slice(0, 8).map(item => `${item.provider}/${item.model} (${item.attempts} attempts, success ${(item.successRate * 100).toFixed(0)}%, latency ${item.averageLatencyMs == null ? 'n/a' : Math.round(item.averageLatencyMs) + 'ms'})`).join('; ');
  return [
    'MODEL INTELLIGENCE:',
    `Current configured model: ${data.currentModel}.`,
    `Provider mode: ${data.configuredProviderMode}.`,
    `Accessible catalog: ${data.count} models. Provider counts: ${providerSummary || 'unknown'}.`,
    `Representative accessible models: ${data.models.join(', ') || 'catalog unavailable'}.`,
    `Recent performance leaders${taskType ? ` for ${taskType}` : ''}: ${performanceSummary || 'no performance history yet'}.`,
    'Rule: when asked to rate, compare, choose, or criticize a model, use the model catalog/performance data first; never invent model access or history.',
  ].join('\n');
}

module.exports = { refresh, catalog, context, providerForModel };
