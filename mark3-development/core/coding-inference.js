const integrations = require('./integrations');
const modelLeague = require('./model-league');
const models = require('./model-intelligence');

function roleTaskType(role) {
  const value = String(role || '').toLowerCase();
  if (value === 'editor') return 'coding';
  if (['reviewer', 'planner', 'investigator', 'scope-planner', 'architect', 'dx-planner'].includes(value)) return 'planning';
  return 'coding';
}

function nativeModelForTask(taskType) {
  if (taskType === 'coding') return 'auto/best-coding';
  return 'auto/best-reasoning';
}

function textFromResponse(data) {
  const direct = data?.content ?? data?.response ?? data?.text ?? data?.output_text
    ?? data?.choices?.[0]?.message?.content
    ?? data?.choices?.[0]?.text
    ?? data?.raw?.choices?.[0]?.message?.content
    ?? data?.raw?.response ?? data?.raw?.text ?? '';
  if (typeof direct === 'string') return direct.trim();
  if (Array.isArray(direct)) return direct.map((item) => typeof item === 'string' ? item : item?.text || item?.content || item?.value || '').join('').trim();
  if (direct && typeof direct === 'object') return String(direct.text || direct.content || direct.value || '').trim();
  return '';
}

function sanitizeMessages(messages) {
  const rows = Array.isArray(messages) ? messages.slice(-10) : [];
  let remaining = 190000;
  const result = [];
  for (const row of rows) {
    const role = ['system', 'assistant', 'user'].includes(row?.role) ? row.role : 'user';
    const content = String(row?.content || '').slice(0, Math.max(0, remaining));
    remaining -= content.length;
    if (!content) continue;
    result.push({ role, content });
    if (remaining <= 0) break;
  }
  if (!result.length) throw new Error('Coding inference requires messages.');
  return result;
}

async function infer(role, messages) {
  const taskType = roleTaskType(role);
  const safeMessages = sanitizeMessages(messages);
  const recommendation = modelLeague.recommend(taskType);
  const native = nativeModelForTask(taskType);
  const candidates = recommendation.primary
    ? [...new Set([recommendation.primary, ...(recommendation.backups || []), native])]
    : [native];
  const failures = [];

  for (const candidate of candidates.slice(0, 5)) {
    const provider = integrations.providerFromModel(candidate);
    const exact = integrations.isDirectProviderModel(candidate) && !integrations.isRoutingAlias(candidate);
    const started = Date.now();
    try {
      const data = exact
        ? await integrations.chatExact(safeMessages, candidate, null, { taskType })
        : await integrations.chat(safeMessages, candidate, null, { taskType });
      const text = textFromResponse(data);
      if (!text) throw new Error('Model returned no visible content.');
      const observedModel = data?.model || data?.raw?.model || candidate;
      const observedProvider = data?.provider || data?.raw?.provider || integrations.providerFromModel(observedModel) || provider;
      if (exact) {
        modelLeague.recordTrial({ model: candidate, provider, taskType, success: true, latencyMs: Date.now() - started, tournament: false });
        modelLeague.promote(taskType);
      }
      models.record({ provider: observedProvider, model: observedModel, taskType, success: true, latencyMs: Date.now() - started });
      return { ok: true, role, taskType, text, model: observedModel, provider: observedProvider, exact, candidates };
    } catch (error) {
      const latencyMs = Date.now() - started;
      failures.push({ model: candidate, provider, error: error.message });
      models.record({ provider, model: candidate, taskType, success: false, latencyMs, reason: error.message });
      if (exact) modelLeague.recordTrial({ model: candidate, provider, taskType, success: false, latencyMs, error: error.message, tournament: false });
    }
  }

  const error = new Error(`Coding inference failed for role ${role}.`);
  error.failures = failures;
  throw error;
}

module.exports = { infer, roleTaskType, textFromResponse, sanitizeMessages };
