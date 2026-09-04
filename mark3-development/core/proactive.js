const { emit, subscribe } = require('./events');
const workspace = require('./workspace');
const intent = require('./intent');
const planner = require('./planner');
const verifier = require('./verifier');
const memory = require('./memory');
const modelLeague = require('./model-league');
const conversation = require('./conversation');

let timer = null;
let unsubscribe = null;
let lastFingerprint = '';
let lastAlertAt = 0;
let activeExecution = null;
let originalLeagueRecommend = null;
let originalWebShouldSearch = null;
let originalAssistantHandle = null;
const QUIET_REPEAT_MS = Math.max(5 * 60 * 1000, Number(process.env.ULTRON_M3_PROACTIVE_REPEAT_MS || 60 * 60 * 1000));

function hoursUntil(value) { return value ? (Date.parse(value) - Date.now()) / 3600000 : Infinity; }
function staleDays(value) { return value ? Math.max(0, (Date.now() - Date.parse(value)) / 86400000) : 0; }
function scoreItem(item, kind) {
  let score = 0;
  const dueHours = hoursUntil(item.dueAt);
  if (item.priority === 'critical') score += 55;
  else if (item.priority === 'high') score += 35;
  else if (item.priority === 'medium') score += 15;
  else score += 5;
  if (dueHours < 0) score += Math.min(45, 25 + Math.abs(dueHours) / 8);
  else if (dueHours <= 24) score += 25;
  else if (dueHours <= 72) score += 12;
  if (item.status === 'blocked' || item.blockedBy) score += 18;
  if (kind === 'task' && staleDays(item.updatedAt) >= 3) score += 10;
  return Math.round(score);
}
function attentionLevel(score) {
  if (score >= 80) return 'critical';
  if (score >= 55) return 'important';
  if (score >= 30) return 'briefing';
  return 'silent';
}
function attentionFeed() {
  const tasks = workspace.listTasks().filter((item) => !['completed', 'cancelled', 'archived'].includes(item.status));
  const commitments = workspace.listCommitments().filter((item) => !['completed', 'cancelled', 'archived'].includes(item.status));
  return [
    ...tasks.map((item) => ({ kind: 'task', item, score: scoreItem(item, 'task') })),
    ...commitments.map((item) => ({ kind: 'commitment', item, score: scoreItem(item, 'commitment') })),
  ].map((row) => ({ ...row, level: attentionLevel(row.score) })).sort((a, b) => b.score - a.score);
}
function fingerprint(items) { return items.map((row) => `${row.kind}:${row.item.id}:${row.item.status}:${row.item.dueAt || ''}:${row.item.priority}:${row.item.updatedAt}`).join('|'); }
function briefing(limit = 5) {
  const feed = attentionFeed().filter((row) => row.level !== 'silent').slice(0, limit);
  const state = workspace.stateSnapshot();
  return { generatedAt: new Date().toISOString(), topAction: state.topAction, attention: feed, blocked: state.blocked.slice(0, 5), summary: workspace.renderBriefing(state) };
}
function evaluate() {
  const feed = attentionFeed();
  const interrupt = feed.filter((row) => row.level === 'critical' || row.level === 'important').slice(0, 5);
  const key = fingerprint(interrupt);
  if (!key) { lastFingerprint = ''; return { emitted: false, attention: feed }; }
  const repeatedTooSoon = key === lastFingerprint && Date.now() - lastAlertAt < QUIET_REPEAT_MS;
  if (!repeatedTooSoon) {
    lastFingerprint = key;
    lastAlertAt = Date.now();
    emit('proactive_alert', {
      priority: interrupt.some((row) => row.level === 'critical') ? 3 : 2,
      reason: interrupt.some((row) => hoursUntil(row.item.dueAt) < 0) ? 'overdue_or_critical_work' : 'important_work_needs_attention',
      attention: interrupt,
      summary: workspace.renderBriefing(workspace.stateSnapshot()),
    });
    return { emitted: true, attention: feed };
  }
  return { emitted: false, attention: feed };
}

function localDayKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function taskLabel(item) {
  return `${item.title}${item.project ? ` (${item.project})` : ''}`;
}
function listPhrase(items, limit = 4) {
  const rows = items.slice(0, limit).map(taskLabel);
  if (!rows.length) return '';
  return rows.join('; ');
}
function stateResponse(message) {
  const text = intent.stripAssistantInvocation ? intent.stripAssistantInvocation(message) : String(message || '').trim();
  const lower = text.toLowerCase();
  const state = workspace.stateSnapshot();
  const tasks = state.tasks.filter((item) => !['completed', 'cancelled', 'archived'].includes(String(item.status || '').toLowerCase()));
  const goals = state.goals.filter((item) => !['completed', 'cancelled', 'archived'].includes(String(item.status || '').toLowerCase()));
  const commitments = state.commitments.filter((item) => !['completed', 'cancelled', 'archived'].includes(String(item.status || '').toLowerCase()));
  const now = new Date();
  const today = localDayKey(now);
  const startToday = new Date(now); startToday.setHours(0, 0, 0, 0);
  const dueToday = tasks.filter((item) => item.dueAt && localDayKey(item.dueAt) === today);
  const overdue = tasks.filter((item) => item.dueAt && Date.parse(item.dueAt) < startToday.getTime());

  if (/\btoday\b/.test(lower) && /\b(?:task|tasks|todo|to-do|pending|due|work)\b/.test(lower)) {
    if (dueToday.length) return `Sir, you have ${dueToday.length} pending task${dueToday.length === 1 ? '' : 's'} due today: ${listPhrase(dueToday)}.`;
    if (overdue.length) return `Sir, nothing is due today, but you have ${overdue.length} overdue task${overdue.length === 1 ? '' : 's'}: ${listPhrase(overdue)}.`;
    if (tasks.length) return `Sir, no task is due today. You still have ${tasks.length} open task${tasks.length === 1 ? '' : 's'}: ${listPhrase(tasks)}.`;
    return 'Sir, there are no active tasks recorded in your ULTRON workspace today.';
  }

  if (/\b(?:goal|goals)\b/.test(lower)) {
    return goals.length
      ? `Sir, you have ${goals.length} active goal${goals.length === 1 ? '' : 's'}: ${listPhrase(goals)}.`
      : 'Sir, there are no active goals recorded.';
  }

  if (/\b(?:waiting|blocked)\b/.test(lower)) {
    return state.blocked.length
      ? `Sir, ${state.blocked.length} item${state.blocked.length === 1 ? ' is' : 's are'} blocked: ${listPhrase(state.blocked)}.`
      : 'Sir, nothing is currently marked blocked or waiting.';
  }

  if (/\b(?:task|tasks|todo|to-do|pending)\b/.test(lower)) {
    return tasks.length
      ? `Sir, you have ${tasks.length} open task${tasks.length === 1 ? '' : 's'}: ${listPhrase(tasks)}.`
      : 'Sir, there are no active tasks recorded.';
  }

  if (/\b(?:commitment|commitments|deadline|deadlines)\b/.test(lower)) {
    return commitments.length
      ? `Sir, you have ${commitments.length} open commitment${commitments.length === 1 ? '' : 's'}: ${listPhrase(commitments)}.`
      : 'Sir, there are no open commitments recorded.';
  }

  if (/\b(?:priority|priorities|what should i|what'?s next|next)\b/.test(lower)) {
    return state.topAction
      ? `Sir, your next priority is ${taskLabel(state.topAction)}.`
      : 'Sir, no next priority is currently recorded.';
  }

  return `Sir, ${workspace.renderBriefing(state)}`;
}

function syncStateMemory() {
  const state = workspace.stateSnapshot();
  const content = [
    `Current workspace status: ${state.counts.projects} active project(s), ${state.counts.goals} active goal(s), ${state.counts.tasks} active task(s), ${state.counts.commitments} open commitment(s).`,
    state.topAction ? `Next priority: ${state.topAction.title}${state.topAction.project ? ` for ${state.topAction.project}` : ''}.` : 'No next priority is currently recorded.',
    state.goals.length ? `Active goals: ${state.goals.slice(0, 5).map((item) => item.title).join('; ')}.` : '',
    state.tasks.length ? `Active tasks: ${state.tasks.slice(0, 8).map((item) => `${item.title}${item.project ? ` [${item.project}]` : ''}${item.dueAt ? ` due ${item.dueAt}` : ''}`).join('; ')}.` : '',
    state.blocked.length ? `Waiting/blocked: ${state.blocked.slice(0, 5).map((item) => `${item.title}${item.blockedBy ? ` -> ${item.blockedBy}` : ''}`).join('; ')}.` : '',
  ].filter(Boolean).join(' ');
  return memory.remember({
    type: 'strategic',
    key: 'ultron:workspace:current_state',
    entity: 'ULTRON workspace',
    relation: 'current state',
    content,
    importance: 0.95,
    source: 'state-engine',
    tags: ['status', 'work', 'priority', 'priorities', 'next', 'tasks', 'goals', 'pending', 'waiting'],
  });
}

function currentExecution() {
  if (!activeExecution) return null;
  return workspace.listExecutions(50).find((item) => item.id === activeExecution.id) || null;
}
function addEvidence(text) {
  const current = currentExecution();
  if (!current || !text) return;
  const evidence = [...(Array.isArray(current.evidence) ? current.evidence : []), String(text).slice(0, 500)].slice(-12);
  workspace.updateExecution(current.id, { evidence });
}
function deriveVerification(baseResult = null) {
  const current = currentExecution();
  if (!current) return baseResult;
  const kind = current.kind || current.planKind || 'advice';
  const evidence = Array.isArray(current.evidence) ? current.evidence : [];
  if (kind === 'advice') return baseResult || verifier.verifyExecution({ kind, response: 'completed' });
  if (kind === 'state_change') return verifier.verifyExecution({ kind, stateChanged: Boolean(current.stateChanged), evidence });
  if (kind === 'research') {
    const sourceCount = evidence.filter((item) => /research_agent|web_search|web_fetch/i.test(String(item))).length;
    return verifier.verifyExecution({ kind, response: baseResult?.ok ? 'response produced' : '', sourceCount, evidence });
  }
  if (kind === 'repository_action') {
    const changeEvidence = evidence.filter((item) => /github_(?:update|create)_file|coding|changed file|commit/i.test(String(item))).length;
    const verifiedEvidence = evidence.some((item) => /verified|validation|pass|success/i.test(String(item)));
    return verifier.verifyExecution({ kind, changedFiles: changeEvidence, validation: verifiedEvidence ? 'verified' : '', evidence });
  }
  if (kind === 'artifact') {
    const artifactCount = evidence.filter((item) => /artifact|file.*persist|download/i.test(String(item))).length;
    return verifier.verifyExecution({ kind, artifactCount, evidence });
  }
  return baseResult || verifier.verifyExecution({ kind, response: 'completed', evidence });
}
function finishExecution(result = null, fallbackStatus = 'partial') {
  const current = currentExecution();
  if (!current) { activeExecution = null; return; }
  const finalResult = result ? deriveVerification(result) : null;
  const patch = finalResult
    ? { verification: finalResult, status: finalResult.ok ? 'verified' : finalResult.status === 'failed' ? 'failed' : finalResult.status || fallbackStatus }
    : { status: fallbackStatus };
  try { workspace.updateExecution(current.id, patch); } catch {}
  activeExecution = null;
}
function onRuntimeEvent(event) {
  if (event.type === 'task_started') {
    if (conversation.isGreeting(event.message)) return;
    if (intent.isStateBriefRequest(event.message)) syncStateMemory();
    const mutation = intent.extractWorkspaceMutation(event.message);
    let stateChanged = false;
    if (mutation) {
      const applied = workspace.applyMutation(mutation);
      stateChanged = Boolean(applied);
      syncStateMemory();
      emit('workspace_state_changed', { mutation, applied });
    }
    const kind = planner.classify(event.message, event.taskType);
    activeExecution = workspace.recordExecution({ objective: event.message, taskType: event.taskType, status: 'executing' });
    activeExecution.kind = kind;
    workspace.updateExecution(activeExecution.id, { kind, stateChanged });
    return;
  }
  if (!activeExecution) return;
  if (event.type === 'plan_created') {
    workspace.updateExecution(activeExecution.id, { planId: event.plan?.id || null, planKind: event.plan?.kind || activeExecution.kind });
    return;
  }
  if (event.type === 'tool_completed') {
    addEvidence(`${event.tool}${event.result?.verified === true ? ' verified' : ''} completed`);
    return;
  }
  if (event.type === 'tool_failed') {
    addEvidence(`${event.tool} failed: ${event.error || 'unknown error'}`);
    return;
  }
  if (event.type === 'coding_brain_completed') {
    const evidence = [event.review ? `review=${event.review}` : '', event.validation ? `validation=${event.validation}` : ''].filter(Boolean);
    for (const item of evidence) addEvidence(item);
    const result = verifier.verifyExecution({
      kind: 'repository_action',
      changedFiles: Array.isArray(event.changedFiles) ? event.changedFiles.length : 0,
      validation: event.validation || '',
      evidence,
    });
    verifier.report(result, 'coding-brain-execution');
    finishExecution(result);
    return;
  }
  if (event.type === 'verification_complete') {
    if (event.operation === 'coding-brain-execution') return;
    if (event.result) finishExecution(event.result);
    return;
  }
  if (event.type === 'task_completed') finishExecution(null, 'completed');
}

function demoteModelLeague() {
  const enabled = /^(1|true|yes|on)$/i.test(String(process.env.ULTRON_M3_LEAGUE_ENABLED || '0'));
  if (enabled || originalLeagueRecommend) return;
  originalLeagueRecommend = modelLeague.recommend;
  modelLeague.recommend = (taskType = 'general') => ({ taskType, primary: null, backups: [], ranked: [], rounds: 0, lastTournamentAt: null, transportPolicy: 'diagnostic-opt-in' });
}
function restoreModelLeague() {
  if (originalLeagueRecommend) modelLeague.recommend = originalLeagueRecommend;
  originalLeagueRecommend = null;
}
function installLocalStateFastpath() {
  const web = require('./web');
  const assistant = require('./assistant');
  if (!originalWebShouldSearch) {
    originalWebShouldSearch = web.shouldSearch;
    web.shouldSearch = (text) => intent.isStateBriefRequest(text) ? false : originalWebShouldSearch(text);
  }
  if (!originalAssistantHandle) {
    originalAssistantHandle = assistant.handle;
    assistant.handle = async (message, options = {}) => {
      if (!intent.isStateBriefRequest(message)) return originalAssistantHandle(message, options);
      const userMessage = String(message || '').trim();
      const inputMode = String(options.inputMode || 'chat').toLowerCase() === 'voice' ? 'voice' : 'chat';
      syncStateMemory();
      const response = stateResponse(userMessage);
      conversation.append('user', userMessage, { taskType: 'state', inputMode });
      conversation.append('assistant', response, { model: 'mark3-state-engine', provider: 'local', taskType: 'state', mode: 'state-fastpath', inputMode });
      emit('context_ready', { contextMode: 'local-workspace-state', taskCount: workspace.listTasks().length, goalCount: workspace.listGoals().length, inputMode });
      emit('response_ready', { model: 'mark3-state-engine', provider: 'local', taskType: 'state', mode: 'state-fastpath', inputMode });
      void require('./voice-orchestrator').enqueue(response);
      return { ok: true, response, text: response, model: 'mark3-state-engine', provider: 'local', taskType: 'state', mode: 'state-fastpath', inputMode, plan: null, toolRounds: 0, streamed: false };
    };
  }
}
function restoreLocalStateFastpath() {
  const web = require('./web');
  const assistant = require('./assistant');
  if (originalWebShouldSearch) web.shouldSearch = originalWebShouldSearch;
  if (originalAssistantHandle) assistant.handle = originalAssistantHandle;
  originalWebShouldSearch = null;
  originalAssistantHandle = null;
}
function start(intervalMs) {
  stop();
  demoteModelLeague();
  installLocalStateFastpath();
  unsubscribe = subscribe(onRuntimeEvent);
  syncStateMemory();
  timer = setInterval(evaluate, intervalMs);
  timer.unref?.();
  evaluate();
}
function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  activeExecution = null;
  restoreLocalStateFastpath();
  restoreModelLeague();
}
module.exports = { start, stop, evaluate, attentionFeed, briefing, scoreItem, attentionLevel, onRuntimeEvent, syncStateMemory, stateResponse };
