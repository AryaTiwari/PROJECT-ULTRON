const { emit } = require('./events');
const workspace = require('./workspace');

let timer = null;
let lastFingerprint = '';
let lastAlertAt = 0;
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
  const rows = [
    ...tasks.map((item) => ({ kind: 'task', item, score: scoreItem(item, 'task') })),
    ...commitments.map((item) => ({ kind: 'commitment', item, score: scoreItem(item, 'commitment') })),
  ].map((row) => ({ ...row, level: attentionLevel(row.score) })).sort((a, b) => b.score - a.score);
  return rows;
}
function fingerprint(items) { return items.map((row) => `${row.kind}:${row.item.id}:${row.item.status}:${row.item.dueAt || ''}:${row.item.priority}:${row.item.updatedAt}`).join('|'); }
function briefing(limit = 5) {
  const feed = attentionFeed().filter((row) => row.level !== 'silent').slice(0, limit);
  const state = workspace.stateSnapshot();
  return {
    generatedAt: new Date().toISOString(),
    topAction: state.topAction,
    attention: feed,
    blocked: state.blocked.slice(0, 5),
    summary: workspace.renderBriefing(state),
  };
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
function start(intervalMs) { stop(); timer = setInterval(evaluate, intervalMs); timer.unref?.(); evaluate(); }
function stop() { if (timer) clearInterval(timer); timer = null; }
module.exports = { start, stop, evaluate, attentionFeed, briefing, scoreItem, attentionLevel };
