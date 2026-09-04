const operator = require('./operator');

let installed = false;
let originalHandle = null;

function statusResponse() {
  const rows = operator.status();
  const ready = rows.filter((row) => row.ready);
  const building = rows.filter((row) => !row.implemented);
  const waiting = rows.filter((row) => row.implemented && !row.credentialsReady);
  const lines = [
    'Sir, Operator Mode is active.',
    ready.length ? `Ready now: ${ready.map((row) => row.title).join(', ')}.` : 'No operator capabilities are fully ready yet.',
    building.length ? `Build next: ${building.map((row) => row.title).join(', ')}.` : '',
    waiting.length ? `Waiting on credentials: ${waiting.map((row) => row.title).join(', ')}.` : '',
  ].filter(Boolean);
  return lines.join(' ');
}

function blockedResponse(state) {
  const missing = state.missing.length ? state.missing.join(', ') : 'connector implementation';
  return `Sir, I recognized this as ${state.title}, but I cannot execute it yet. Missing: ${missing}. I will not pretend the action happened or substitute unrelated web research.`;
}

function tradingBoundary(text, state) {
  if (state.id !== 'trading_research') return null;
  if (!/\b(?:execute|place|open|close|buy|sell|manage)\b[\s\S]{0,60}\b(?:trade|position|order)|\b(?:trade|position|order)\b[\s\S]{0,60}\b(?:automatically|autonomous|without me|execute|place)\b/i.test(String(text || ''))) return null;
  return 'Sir, I can research, backtest, generate alerts and run the strategy in paper/simulated mode, but I will not autonomously place or manage real-money trades.';
}

function isStatusRequest(text) {
  return /^(?:ultron\s+)?(?:operator|capabilities?|what can you do)(?:\s+status)?[?.!\s]*$/i.test(String(text || '').trim())
    || /\boperator\s+(?:status|capabilities)\b/i.test(String(text || ''));
}

function install() {
  if (installed) return { installed: true, alreadyInstalled: true };
  const assistant = require('./assistant');
  const conversation = require('./conversation');
  const voice = require('./voice-orchestrator');
  const { emit } = require('./events');
  if (!assistant?.handle) throw new Error('Assistant handle is unavailable for Operator Mode.');
  originalHandle = assistant.handle;

  assistant.handle = async (message, options = {}) => {
    const text = String(message || '').trim();
    const inputMode = String(options.inputMode || 'chat').toLowerCase() === 'voice' ? 'voice' : 'chat';

    if (isStatusRequest(text)) {
      const response = statusResponse();
      conversation.append('user', text, { taskType: 'operator-status', inputMode });
      conversation.append('assistant', response, { model: 'operator-router', provider: 'local', taskType: 'operator-status', inputMode });
      emit('operator_status_requested', { inputMode, status: operator.summary() });
      void voice.enqueue(response);
      return { ok: true, response, text: response, model: 'operator-router', provider: 'local', taskType: 'operator-status', mode: 'operator', inputMode, toolRounds: 0 };
    }

    const capability = operator.match(text);
    if (!capability) return originalHandle(message, options);
    const state = operator.capabilityState(capability);
    emit('operator_intent', { capability: state.id, title: state.title, ready: state.ready, implemented: state.implemented, credentialsReady: state.credentialsReady, inputMode });

    const boundary = tradingBoundary(text, state);
    if (boundary) {
      conversation.append('user', text, { taskType: 'trading-research', inputMode });
      conversation.append('assistant', boundary, { model: 'operator-router', provider: 'local', taskType: 'trading-research', inputMode });
      void voice.enqueue(boundary);
      return { ok: true, response: boundary, text: boundary, model: 'operator-router', provider: 'local', taskType: 'trading-research', mode: 'operator', capability: state.id, inputMode, toolRounds: 0 };
    }

    if (!state.ready && state.id !== 'software_build') {
      const response = blockedResponse(state);
      conversation.append('user', text, { taskType: `operator-${state.id}`, inputMode });
      conversation.append('assistant', response, { model: 'operator-router', provider: 'local', taskType: `operator-${state.id}`, inputMode });
      emit('operator_blocked', { capability: state.id, missing: state.missing, inputMode });
      void voice.enqueue(response);
      return { ok: true, response, text: response, model: 'operator-router', provider: 'local', taskType: `operator-${state.id}`, mode: 'operator-blocked', capability: state.id, missing: state.missing, inputMode, toolRounds: 0 };
    }

    const taskType = state.id === 'creator_research' || state.id === 'trading_research' ? 'research' : options.taskType;
    return originalHandle(message, { ...options, taskType: taskType || options.taskType, operatorCapability: state.id });
  };

  installed = true;
  emit('operator_ready', { status: operator.summary() });
  return { installed: true, status: operator.summary() };
}

function uninstall() {
  if (!installed) return;
  const assistant = require('./assistant');
  if (originalHandle) assistant.handle = originalHandle;
  originalHandle = null;
  installed = false;
}

function status() { return { installed, capabilities: operator.status() }; }

module.exports = { install, uninstall, status, statusResponse, blockedResponse, tradingBoundary, isStatusRequest };
