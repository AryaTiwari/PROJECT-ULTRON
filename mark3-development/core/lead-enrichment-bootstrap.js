const sheets = require('./google-sheets-operator');
const leadEnrichment = require('./lead-enrichment-operator');

let installed = false;
let originalHandle = null;

function isEnrichmentRequest(text) {
  const value = String(text || '').trim();
  const url = sheets.extractSheetUrl(value);
  if (!url) return null;
  if (!/\b(?:enrich|apollo|fill|find|get|add|update|phone|email|contact|lead)\b/i.test(value)) return null;
  return { url };
}

function isStatusRequest(text) {
  return /\b(?:apollo|lead)\s+enrichment\s+status\b|\benrichment\s+status\b/i.test(String(text || ''));
}

function isResumeRequest(text) {
  return /\b(?:resume|continue|sync|check)\b[\s\S]{0,50}\b(?:apollo|lead|phone)\s+enrichment\b|\bresume\s+(?:today'?s\s+)?apollo\b/i.test(String(text || ''));
}

function statusText() {
  const state = leadEnrichment.status();
  const blockers = [];
  if (!state.apollo.apiKeyReady) blockers.push('Apollo API key');
  if (!state.apollo.webhookReady) blockers.push('Apollo webhook');
  if (!state.google.credentialsReady) blockers.push('Google OAuth JSON');
  if (!state.google.authorized) blockers.push('one-time Google login');
  if (blockers.length) return `Apollo + Sheets enrichment is installed, Sir. Still needed: ${blockers.join(', ')}. Pending phone checks: ${state.pendingPhones}.`;
  return `Apollo + Sheets enrichment is ready, Sir. Pending phone checks: ${state.pendingPhones}.`;
}

function responseShape(ok, text, extra = {}) {
  return {
    ok,
    response: text,
    text,
    model: 'apollo-sheets-operator',
    provider: 'apollo+google',
    taskType: 'lead-enrichment',
    mode: 'operator',
    toolRounds: 0,
    ...extra,
  };
}

async function handleEnrichment(url) {
  try {
    const stats = await leadEnrichment.enrichSheet(url);
    return responseShape(true, leadEnrichment.formatResult(stats), { leadEnrichment: stats });
  } catch (error) {
    if (error.code === 'GOOGLE_SHEETS_AUTH_REQUIRED') {
      return responseShape(false, leadEnrichment.authInstruction(), { error: error.code });
    }
    if (error.code === 'GOOGLE_SHEETS_CREDENTIALS_MISSING') {
      return responseShape(false, `Google OAuth JSON is missing, Sir. Expected: ${require('./google-sheets-auth').status().credentialsPath}`, { error: error.code });
    }
    return responseShape(false, `Lead enrichment stopped safely: ${error.message}`, { error: error.code || error.message });
  }
}

async function handleResume() {
  try {
    const result = await leadEnrichment.resume();
    const text = result.resumed && result.stats
      ? leadEnrichment.formatResult(result.stats)
      : `Apollo phone sync checked, Sir. Resolved ${result.resolved || 0}; ${result.pending || 0} still pending.`;
    return responseShape(true, text, { leadEnrichment: result });
  } catch (error) {
    if (error.code === 'GOOGLE_SHEETS_AUTH_REQUIRED') return responseShape(false, leadEnrichment.authInstruction(), { error: error.code });
    return responseShape(false, `Apollo enrichment resume failed safely: ${error.message}`, { error: error.code || error.message });
  }
}

function install() {
  if (installed) return { installed: true, alreadyInstalled: true, status: leadEnrichment.status() };
  const assistant = require('./assistant');
  const conversation = require('./conversation');
  const voice = require('./voice-orchestrator');
  const { emit } = require('./events');
  originalHandle = assistant.handle;

  assistant.handle = async (message, options = {}) => {
    const text = String(message || '').trim();
    const inputMode = String(options.inputMode || 'chat').toLowerCase() === 'voice' ? 'voice' : 'chat';
    let result = null;

    const request = isEnrichmentRequest(text);
    if (request) {
      conversation.append('user', text, { taskType: 'lead-enrichment', inputMode });
      emit('lead_enrichment_started', { inputMode });
      result = await handleEnrichment(request.url);
      emit(result.ok ? 'lead_enrichment_completed' : 'lead_enrichment_failed', { inputMode, error: result.error || null });
    } else if (isResumeRequest(text)) {
      conversation.append('user', text, { taskType: 'lead-enrichment-resume', inputMode });
      result = await handleResume();
    } else if (isStatusRequest(text)) {
      conversation.append('user', text, { taskType: 'lead-enrichment-status', inputMode });
      result = responseShape(true, statusText(), { leadEnrichment: leadEnrichment.status() });
    }

    if (!result) return originalHandle(message, options);
    conversation.append('assistant', result.text, { model: result.model, provider: result.provider, taskType: result.taskType, inputMode, ok: result.ok });
    void voice.enqueue(result.text);
    return { ...result, inputMode };
  };

  installed = true;
  if (leadEnrichment.pendingCount()) leadEnrichment.startPhoneWatcher();
  return { installed: true, status: leadEnrichment.status() };
}

function uninstall() {
  if (!installed) return;
  const assistant = require('./assistant');
  if (originalHandle) assistant.handle = originalHandle;
  originalHandle = null;
  installed = false;
}

function status() {
  return { installed, ...leadEnrichment.status() };
}

module.exports = {
  install,
  uninstall,
  status,
  statusText,
  isEnrichmentRequest,
  isStatusRequest,
  isResumeRequest,
  handleEnrichment,
  handleResume,
};
