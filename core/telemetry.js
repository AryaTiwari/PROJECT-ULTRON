const { config } = require('./config');
const supabase = require('./memory/supabase');
const local = require('./memory/local-store');

async function recordModelResult({ provider = 'omniroute', model, taskType, success, qualityScore = null, latencyMs = null, errorType = null, metadata = {} } = {}) {
  const event = {
    provider,
    model: model || 'unknown',
    task_type: taskType || null,
    success: Boolean(success),
    quality_score: qualityScore,
    latency_ms: latencyMs,
    error_type: errorType,
    metadata,
    created_at: new Date().toISOString(),
  };

  if (supabase.available()) {
    try {
      await supabase.insertModelPerformance(event);
      return event;
    } catch {
      // Continue to local fallback below.
    }
  }

  local.appendModelPerformance(event);
  return event;
}

module.exports = { recordModelResult };
