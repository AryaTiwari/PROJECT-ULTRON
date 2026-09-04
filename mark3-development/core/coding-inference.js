const integrations = require('./integrations');
const modelLeague = require('./model-league');
const models = require('./model-intelligence');
const forgeGovernor = require('./forge/model-governor');

function roleTaskType(role) {
  const value = String(role || '').toLowerCase();
  if (value === 'editor') return 'coding';
  if (['reviewer', 'planner', 'investigator', 'scope-planner', 'architect', 'dx-planner'].includes(value)) return 'planning';
  return 'coding';
}
function forgeRole(role) {
  const value = String(role || '').toLowerCase();
  if (value === 'editor') return 'code_build';
  if (value === 'reviewer') return 'code_review';
  if (['planner', 'investigator', 'scope-planner', 'architect', 'dx-planner'].includes(value)) return 'architecture';
  return 'code_build';
}
function allowGeneralFallback() {
  return /^(1|true|yes|on)$/i.test(String(process.env.ULTRON_M3_CODING_ALLOW_GENERAL_FALLBACK || '0'));
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
async function inferWithForge(role, safeMessages) {
  const started = Date.now();
  const taskType = roleTaskType(role);
  const selectedRole = forgeRole(role);
  try {
    const result = await forgeGovernor.nvidiaChat({
      role: selectedRole,
      messages: safeMessages,
      temperature: selectedRole === 'code_build' ? 0.15 : 0.1,
      maxTokens: selectedRole === 'code_build' ? 12000 : 8000,
    });
    models.record({ provider: 'nvidia', model: result.model, taskType, success: true, latencyMs: Date.now() - started });
    return {
      ok: true,
      role,
      taskType,
      text: result.text,
      model: result.model,
      provider: 'nvidia',
      exact: true,
      candidates: forgeGovernor.configuredModels(selectedRole),
      forge: true,
      usage: result.usage,
    };
  } catch (error) {
    models.record({ provider: 'nvidia', model: forgeGovernor.configuredModels(selectedRole)[0], taskType, success: false, latencyMs: Date.now() - started, reason: error.message });
    throw error;
  }
}
async function inferGeneralFallback(role, safeMessages) {
  const taskType = roleTaskType(role);
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
      models.record({ provider: observedProvider, model: observedModel, taskType, success: true, latencyMs: Date.now() - started });
      return { ok: true, role, taskType, text, model: observedModel, provider: observedProvider, exact, candidates, forge: false };
    } catch (error) {
      const latencyMs = Date.now() - started;
      failures.push({ model: candidate, provider, error: error.message });
      models.record({ provider, model: candidate, taskType, success: false, latencyMs, reason: error.message });
    }
  }
  const error = new Error(`General coding fallback failed for role ${role}.`);
  error.failures = failures;
  throw error;
}
async function infer(role, messages) {
  const safeMessages = sanitizeMessages(messages);
  try {
    return await inferWithForge(role, safeMessages);
  } catch (forgeError) {
    if (!allowGeneralFallback()) throw forgeError;
    const fallback = await inferGeneralFallback(role, safeMessages);
    return { ...fallback, forgeFailure: forgeError.message };
  }
}

module.exports = { infer, inferWithForge, inferGeneralFallback, roleTaskType, forgeRole, textFromResponse, sanitizeMessages, allowGeneralFallback };
