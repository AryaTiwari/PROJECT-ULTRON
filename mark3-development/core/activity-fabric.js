const path = require('path');
const config = require('./config');
const { appendJsonl, readJsonl } = require('./persistence');
const events = require('./events');

const ACTIVITY_PATH = path.join(config.dataDir, 'activity.jsonl');
const MAX_READ = Math.max(100, Number(process.env.ULTRON_M3_ACTIVITY_MAX_READ || 1200));
let installed = false;
let unsubscribe = null;

const MEANINGFUL = new Set([
  'task_started','task_completed','response_ready',
  'tool_completed','coding_completed','coding_failed',
  'reel_factory_started','reel_factory_completed','reel_factory_failed',
  'reel_attachment_completed','reel_feedback_recorded','reel_performance_synced',
  'forge_mission_created','forge_mission_completed','forge_mission_blocked','forge_mission_failed',
  'adaptive_observation_saved','adaptive_proposal_created','adaptive_proposal_approved','adaptive_proposal_rejected',
  'instagram_verified','instagram_insights_synced','instagram_publish_completed',
  'research_completed','system_coach_suggestion',
  'file_uploaded','media_generation_completed',
]);

function clean(value, max = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1)).trim()}…` : text;
}

function sourceFor(type = '') {
  if (/reel/i.test(type)) return 'reel';
  if (/forge|coding/i.test(type)) return 'forge';
  if (/adaptive/i.test(type)) return 'adaptive';
  if (/instagram/i.test(type)) return 'instagram';
  if (/research/i.test(type)) return 'research';
  if (/system_coach|diagnostic/i.test(type)) return 'diagnostics';
  if (/media|file/i.test(type)) return 'artifacts';
  if (/task|response|tool/i.test(type)) return 'assistant';
  return 'system';
}

function summarize(event = {}) {
  const type = String(event.type || 'event');
  const candidates = [
    event.message, event.objective, event.title, event.brief, event.task, event.reason,
    event.result?.title, event.result?.summary, event.response, event.error,
  ].filter(Boolean);
  let summary = clean(candidates[0] || type.replace(/_/g, ' '), 190);
  if (type === 'task_started' && event.message) summary = clean(`Started: ${event.message}`, 190);
  if (type === 'task_completed') summary = clean(event.message || `Task completed${event.durationMs ? ` in ${Math.round(event.durationMs / 1000)}s` : ''}`, 190);
  if (type === 'system_coach_suggestion') summary = clean(event.message || event.reason || 'System Coach found something worth checking.', 190);
  return summary;
}

function normalize(event = {}) {
  return {
    id: event.id || `activity-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    at: event.at || new Date().toISOString(),
    type: String(event.type || 'event'),
    source: sourceFor(event.type),
    summary: summarize(event),
    taskType: event.taskType || null,
    status: event.ok === false || /failed|blocked/i.test(String(event.type || '')) ? 'attention' : /completed|approved|verified|synced/i.test(String(event.type || '')) ? 'done' : 'info',
    ref: event.jobId || event.missionId || event.artifactId || event.mediaId || event.proposalId || null,
  };
}

function record(event) {
  if (!event || !MEANINGFUL.has(String(event.type || ''))) return null;
  const row = normalize(event);
  appendJsonl(ACTIVITY_PATH, row);
  return row;
}

function recent(limit = 20) {
  return readJsonl(ACTIVITY_PATH)
    .slice(-MAX_READ)
    .slice(-Math.max(1, Math.min(100, Number(limit || 20))))
    .reverse();
}

function recentBySource(source, limit = 8) {
  return recent(80).filter((row) => row.source === source).slice(0, Math.max(1, limit));
}

function latestMeaningful() {
  return recent(30).find((row) => row.status === 'done' || row.status === 'attention') || recent(1)[0] || null;
}

function promptSummary(limit = 8) {
  const rows = recent(limit);
  if (!rows.length) return 'No cross-feature activity has been recorded yet.';
  return rows.map((row) => `${row.source}:${row.status} — ${row.summary}`).join(' | ');
}

function install() {
  if (installed) return status();
  unsubscribe = events.subscribe((event) => { try { record(event); } catch {} });
  installed = true;
  return status();
}

function uninstall() {
  unsubscribe?.();
  unsubscribe = null;
  installed = false;
  return status();
}

function status() {
  return { installed, path: ACTIVITY_PATH, recentCount: recent(40).length, meaningfulTypes: MEANINGFUL.size };
}

module.exports = { ACTIVITY_PATH, MEANINGFUL, normalize, record, recent, recentBySource, latestMeaningful, promptSummary, install, uninstall, status };
