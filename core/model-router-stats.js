const local = require('./memory/local-store');

function summarize(events, taskType) {
  const relevant = events.filter(event => !taskType || event.task_type === taskType);
  const grouped = new Map();
  for (const event of relevant) {
    const key = `${event.provider || 'unknown'}::${event.model || 'unknown'}`;
    const current = grouped.get(key) || { provider: event.provider || 'unknown', model: event.model || 'unknown', attempts: 0, successes: 0, qualityTotal: 0, qualityCount: 0, latencyTotal: 0, latencyCount: 0 };
    current.attempts += 1;
    if (event.success) current.successes += 1;
    if (Number.isFinite(event.quality_score)) { current.qualityTotal += event.quality_score; current.qualityCount += 1; }
    if (Number.isFinite(event.latency_ms)) { current.latencyTotal += event.latency_ms; current.latencyCount += 1; }
    grouped.set(key, current);
  }
  return [...grouped.values()].map(item => ({
    provider: item.provider,
    model: item.model,
    attempts: item.attempts,
    successRate: item.successes / item.attempts,
    averageQuality: item.qualityCount ? item.qualityTotal / item.qualityCount : null,
    averageLatencyMs: item.latencyCount ? item.latencyTotal / item.latencyCount : null,
  }));
}

function rank(events, taskType) {
  return summarize(events, taskType).map(item => ({
    ...item,
    score: (item.averageQuality ?? (item.successRate * 0.8)) * 0.7 + item.successRate * 0.2 + (item.averageLatencyMs ? Math.max(0, 1 - item.averageLatencyMs / 10000) * 0.1 : 0.1),
  })).sort((a, b) => b.score - a.score);
}

function bestLearnedModel(taskType) {
  const ranked = rank(local.getModelPerformance(1000), taskType);
  return ranked[0] || null;
}

module.exports = { summarize, rank, bestLearnedModel };
