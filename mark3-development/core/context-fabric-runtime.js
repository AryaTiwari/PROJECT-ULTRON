const integrations = require('./integrations');
const assistant = require('./assistant');
const conversation = require('./conversation');
const greeting = require('./greeting');
const fabric = require('./context-fabric');
const voice = require('./voice-orchestrator');
const { emit } = require('./events');

let installed = false;
let original = {};

function lastUserMessage(messages = []) {
  const rows = Array.isArray(messages) ? messages : [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i]?.role === 'user' && String(rows[i]?.content || '').trim()) return String(rows[i].content).trim();
  }
  return '';
}

function sharedInstruction(message = '') {
  const ctx = fabric.promptContext(message);
  return [
    'ULTRON SHARED CONTEXT FABRIC:',
    ctx.text,
    'CONVERSATION FLOW: Behave like a continuous working partner, not a stateless input/output terminal. Vary phrasing naturally. Do not mechanically begin every answer with “Sir”, a heading, or the same acknowledgement. A short connective sentence is useful when it reflects real continuity (“That fits what we changed yesterday”, “This is the next weak link”, “The Reel side is healthy; Forge is the part I would inspect”).',
    'ENGAGEMENT RULE: Ordinary answers may be conversationally complete rather than artificially capped at two sentences. Stay concise, but use enough room to make the exchange feel fluid. When there is one genuinely useful live observation, diagnostic warning, unfinished dependency, or next move, surface it naturally. Do not append generic offers or unrelated suggestions.',
    'CROSS-FEATURE RULE: Treat Reel Intelligence, Reel Factory, Research, Instagram, Buffer, Forge, Adaptive Intelligence, memory, workspace, artifacts, diagnostics and Operator Mode as one connected operating system. Reuse outputs and state across those features whenever relevant instead of making the founder restate them.',
    'AUTONOMY RULE: Read-only diagnostics, local analysis, planning and suggestions may happen proactively. External publishing, messaging, destructive changes or account actions remain approval-gated unless the founder explicitly requested that exact action in the current turn and the connector supports it safely.',
    'TRUTH RULE: Never manufacture a previous task, system state or feature result. Continuity must come from the supplied fabric/activity/history only.',
  ].join('\n');
}

function inject(messages = []) {
  const rows = Array.isArray(messages) ? messages.map((item) => ({ ...item })) : [];
  const message = lastUserMessage(rows);
  const instruction = sharedInstruction(message);
  const systemIndex = rows.findIndex((item) => item?.role === 'system');
  if (systemIndex >= 0) {
    rows[systemIndex] = { ...rows[systemIndex], content: `${String(rows[systemIndex].content || '')}\n\n${instruction}` };
  } else {
    rows.unshift({ role: 'system', content: instruction });
  }
  return rows;
}

function wrap(name) {
  if (typeof integrations[name] !== 'function') return;
  original[name] = integrations[name];
  integrations[name] = function wrapped(messages, ...args) {
    return original[name](inject(messages), ...args);
  };
}

async function greetingHandle(message, options = {}) {
  const userMessage = String(message || '').trim();
  const inputMode = String(options.inputMode || 'chat').toLowerCase() === 'voice' ? 'voice' : 'chat';
  const result = greeting.create();
  conversation.append('user', userMessage, { taskType: 'smalltalk', requestedTaskType: 'general', inputMode });
  conversation.append('assistant', result.response, { model: 'context-greeting', provider: 'local', taskType: 'smalltalk', inputMode });
  emit('context_ready', {
    memoryCount: null,
    commitments: result.context?.topAction ? 1 : 0,
    projectCount: null,
    contextMode: 'continuity-greeting',
    previousSession: result.context?.previousSession?.title || null,
    daypart: result.context?.clock?.daypart || null,
    inputMode,
  });
  emit('response_ready', { model: 'context-greeting', provider: 'local', taskType: 'smalltalk', mode: 'continuity-fastpath', inputMode });
  void voice.enqueue(result.response);
  return {
    ok: true,
    response: result.response,
    text: result.response,
    model: 'context-greeting',
    provider: 'local',
    taskType: 'smalltalk',
    mode: 'continuity-fastpath',
    inputMode,
    continuity: result.context,
    plan: null,
    toolRounds: 0,
  };
}

function install() {
  if (installed) return status();
  for (const name of ['chat', 'chatExact', 'streamChat', 'streamExact']) wrap(name);
  original.assistantHandle = assistant.handle;
  assistant.handle = async (message, options = {}) => {
    if (conversation.isGreeting(message)) return greetingHandle(message, options);
    return original.assistantHandle(message, options);
  };
  installed = true;
  return status();
}

function uninstall() {
  if (!installed) return status();
  for (const name of ['chat', 'chatExact', 'streamChat', 'streamExact']) {
    if (original[name]) integrations[name] = original[name];
  }
  if (original.assistantHandle) assistant.handle = original.assistantHandle;
  original = {};
  installed = false;
  return status();
}

function status() {
  return {
    installed,
    timezone: fabric.TIMEZONE,
    persistentHistory: true,
    contextualGreetings: true,
    sharedAcrossModelFeatures: true,
    crossFeatureActivity: true,
    fluidConversationPolicy: true,
    recentSessions: conversation.sessions(6).length,
  };
}

module.exports = { inject, sharedInstruction, greetingHandle, install, uninstall, status };
