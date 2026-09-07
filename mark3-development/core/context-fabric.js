const config = require('./config');
const conversation = require('./conversation');
const workspace = require('./workspace');
const adaptive = require('./adaptive-intelligence');
const operator = require('./operator');

const TIMEZONE = String(process.env.ULTRON_M3_TIMEZONE || 'Asia/Kolkata').trim() || 'Asia/Kolkata';

function clean(value, max = 220) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1)).trim()}…` : text;
}

function clock(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-IN', {
    timeZone: TIMEZONE,
    year: 'numeric', month: 'short', day: '2-digit', weekday: 'long',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  const hour = Number(parts.hour || 0) % 24;
  const daypart = hour >= 5 && hour < 12 ? 'morning'
    : hour >= 12 && hour < 17 ? 'afternoon'
      : hour >= 17 && hour < 22 ? 'evening'
        : 'late-night';
  return {
    timezone: TIMEZONE,
    iso: date.toISOString(),
    weekday: parts.weekday || '',
    dateLabel: `${parts.day || ''} ${parts.month || ''} ${parts.year || ''}`.trim(),
    timeLabel: `${String(hour).padStart(2, '0')}:${parts.minute || '00'}`,
    hour,
    daypart,
  };
}

function dayKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = Object.fromEntries(formatter.formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function executionSummary(row) {
  return {
    id: row.id,
    objective: clean(row.objective, 150),
    taskType: row.taskType || 'general',
    status: row.status || 'unknown',
    completedAt: row.completedAt || row.updatedAt || null,
    verified: Boolean(row.verification?.ok || row.status === 'verified'),
  };
}

function recentWork() {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 86400000);
  const todayKey = dayKey(now);
  const yesterdayKey = dayKey(yesterday);
  const rows = workspace.listExecutions(120);
  const completed = rows.filter((row) => ['verified', 'completed', 'partial'].includes(String(row.status || '').toLowerCase()) && (row.completedAt || row.updatedAt));
  return {
    today: completed.filter((row) => dayKey(row.completedAt || row.updatedAt) === todayKey).slice(0, 8).map(executionSummary),
    yesterday: completed.filter((row) => dayKey(row.completedAt || row.updatedAt) === yesterdayKey).slice(0, 8).map(executionSummary),
    recent: completed.slice(0, 10).map(executionSummary),
  };
}

function sessionContext() {
  const rows = conversation.sessions(10);
  const newest = rows[0] || null;
  const newestAge = newest?.endedAt ? Date.now() - Date.parse(newest.endedAt) : Infinity;
  const current = newest && newestAge <= conversation.SESSION_GAP_MS ? newest : null;
  const previous = current ? rows[1] || null : newest;
  return { current, previous, recent: rows };
}

function safeTurbo() {
  try {
    const turbo = require('./turbo-engine');
    const report = turbo.audit();
    return { report, compact: turbo.compact(report) };
  } catch (error) {
    return { report: null, compact: { score: null, state: 'unavailable', criticalIssue: error.message, topOpportunity: null } };
  }
}

function learnedSummary() {
  const domains = ['communication', 'development', 'design', 'creator-content', 'business'];
  const values = {};
  for (const domain of domains) {
    try {
      const result = adaptive.contextFor(domain, 4);
      if (result?.available) values[domain] = clean(result.summary, 300);
    } catch {}
  }
  return values;
}

function featureMesh() {
  const rows = operator.status();
  const wanted = ['reel_generation', 'reel_strategy', 'adaptive_operator', 'system_audit', 'creator_research', 'software_build', 'instagram_publish', 'instagram_dm'];
  const features = wanted.map((id) => rows.find((row) => row.id === id)).filter(Boolean).map((row) => ({
    id: row.id,
    title: row.title,
    ready: Boolean(row.ready),
    implemented: Boolean(row.implemented),
    mode: row.mode,
  }));
  try {
    const instagram = require('./instagram').status();
    features.push({ id: 'instagram_connection', title: 'Instagram Connection', ready: Boolean(instagram.configured), implemented: true, mode: 'connected-data' });
  } catch {}
  try {
    const buffer = require('./buffer').status();
    features.push({ id: 'buffer', title: 'Buffer', ready: Boolean(buffer.configured || buffer.ready), implemented: true, mode: 'approval-gated-publishing' });
  } catch {}
  try {
    const research = require('./research-turbo-runtime').status();
    features.push({ id: 'research', title: 'Research Fabric', ready: true, implemented: true, mode: `primary+${(research.searchFallbacks || []).join('+') || 'fallbacks'}` });
  } catch {}
  return features;
}

function diagnosticSuggestion(turboData, state) {
  const compact = turboData?.compact || {};
  if (compact.criticalIssue) return { level: 'critical', text: clean(compact.criticalIssue, 220), source: 'turbo-audit' };
  if (state.blocked?.length) {
    const item = state.blocked[0];
    return { level: 'attention', text: `Unblock ${item.title}${item.blockedBy ? `; waiting on ${item.blockedBy}` : ''}.`, source: 'workspace' };
  }
  if (compact.topOpportunity?.reason) return { level: 'suggestion', text: clean(compact.topOpportunity.reason, 220), source: compact.topOpportunity.id || 'turbo-audit' };
  if (state.topAction) return { level: 'focus', text: `Continue ${state.topAction.title}${state.topAction.project ? ` for ${state.topAction.project}` : ''}.`, source: 'workspace' };
  return { level: 'stable', text: 'No urgent system or workspace issue is currently detected.', source: 'context-fabric' };
}

function snapshot(options = {}) {
  const localClock = clock();
  const sessions = sessionContext();
  const work = recentWork();
  const state = workspace.stateSnapshot();
  const turboData = options.diagnostics === false ? { report: null, compact: null } : safeTurbo();
  const diagnostic = options.diagnostics === false ? null : diagnosticSuggestion(turboData, state);
  return {
    generatedAt: new Date().toISOString(),
    clock: localClock,
    sessions,
    work,
    workspace: {
      topAction: state.topAction,
      blocked: state.blocked.slice(0, 5),
      counts: state.counts,
      activeProjects: state.projects.slice(0, 6),
      activeTasks: state.tasks.slice(0, 8),
    },
    learned: learnedSummary(),
    features: featureMesh(),
    diagnostics: turboData.compact,
    diagnostic,
  };
}

function promptContext(message = '') {
  const fabric = snapshot({ diagnostics: true });
  const previous = fabric.sessions.previous;
  const yesterday = fabric.work.yesterday.slice(0, 4);
  const activeFeatureNames = fabric.features.filter((row) => row.ready).map((row) => row.title).slice(0, 8);
  const lines = [
    `CURRENT LOCAL CONTEXT: ${fabric.clock.weekday}, ${fabric.clock.dateLabel}, ${fabric.clock.timeLabel} (${fabric.clock.timezone}); daypart=${fabric.clock.daypart}.`,
    previous ? `PREVIOUS CHAT THREAD: ${previous.title}. Last user request: ${clean(previous.lastUser, 220)}.` : 'PREVIOUS CHAT THREAD: none recorded yet.',
    yesterday.length ? `VERIFIED/COMPLETED YESTERDAY: ${yesterday.map((row) => row.objective).join(' | ')}.` : 'VERIFIED/COMPLETED YESTERDAY: none recorded.',
    fabric.workspace.topAction ? `CURRENT NEXT FOCUS: ${clean(fabric.workspace.topAction.title, 140)}${fabric.workspace.topAction.project ? ` (${fabric.workspace.topAction.project})` : ''}.` : 'CURRENT NEXT FOCUS: none explicitly recorded.',
    fabric.diagnostic ? `SYSTEM COACH: ${fabric.diagnostic.text}` : '',
    activeFeatureNames.length ? `CONNECTED CAPABILITY MESH: ${activeFeatureNames.join(', ')}.` : '',
    'CONTINUITY RULE: Treat this as an ongoing working relationship. Use prior-thread/time/task context only when it naturally helps the current message. Do not force references to unrelated old work. If a useful diagnostic or unfinished thread directly affects the current task, mention it briefly and proactively.',
  ].filter(Boolean);
  return { fabric, text: lines.join('\n') };
}

function compactSnapshot() {
  const value = snapshot({ diagnostics: true });
  return {
    clock: value.clock,
    previousSession: value.sessions.previous ? {
      id: value.sessions.previous.id,
      title: value.sessions.previous.title,
      endedAt: value.sessions.previous.endedAt,
      lastUser: value.sessions.previous.lastUser,
    } : null,
    yesterdayCompleted: value.work.yesterday.slice(0, 5),
    topAction: value.workspace.topAction || null,
    blocked: value.workspace.blocked,
    diagnostic: value.diagnostic,
    health: value.diagnostics,
    features: value.features,
    recentSessions: value.sessions.recent.slice(0, 8),
  };
}

module.exports = { TIMEZONE, clock, dayKey, recentWork, sessionContext, featureMesh, snapshot, promptContext, compactSnapshot, diagnosticSuggestion };