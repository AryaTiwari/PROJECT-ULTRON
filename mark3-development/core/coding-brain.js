const path = require('path');
const config = require('./config');

function enabled() {
  return config.codingBrainEnabled;
}

function shouldUse(message, taskType) {
  if (!enabled()) return false;
  const text = String(message || '').toLowerCase();
  const task = String(taskType || '').toLowerCase();
  const action = /\b(?:fix|implement|add|change|update|modify|edit|refactor|remove|delete|create|build|debug|investigate|inspect|review|test|repair|optimi[sz]e)\b/.test(text);
  const codeSignal = /\b(?:repo|repository|codebase|source|branch|commit|file|function|class|component|server|api|endpoint|route|website|app|interface|frontend|backend|database|module|service|feature|screen|page|project|ultron|elevate|bug|code)\b/.test(text);
  if (task === 'coding') return action;
  return action && codeSignal;
}

function modeFor(message) {
  const text = String(message || '').toLowerCase();
  if (/\b(?:fix|implement|add|change|update|modify|edit|refactor|remove|delete|create|build|repair|optimi[sz]e)\b/.test(text)) return 'apply';
  if (/\b(?:inspect|investigate|review|analy[sz]e|debug|find|check)\b/.test(text)) return 'plan';
  return 'plan';
}

function explicitWorkspace(message) {
  const text = String(message || '');
  const labeled = text.match(/\bworkspace\s*[:=]\s*["']?([^\n"']+)["']?/i);
  if (labeled?.[1]) return labeled[1].trim();
  const windows = text.match(/\b([A-Za-z]:\\[^\n]+?)(?=\s+(?:and|then|please|to)\b|$)/i);
  if (windows?.[1]) return windows[1].trim().replace(/[.,;]+$/, '');
  return '';
}

function resolveWorkspace(message, override) {
  const raw = String(override || explicitWorkspace(message) || config.codingBrainWorkspace || config.projectRoot).trim();
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(config.projectRoot, raw);
}

async function request(url, options = {}, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: text }; }
    if (!response.ok && !(response.status === 422 && data?.mode)) throw new Error(data?.error || `Coding Brain HTTP ${response.status}`);
    return data;
  } finally { clearTimeout(timer); }
}

async function health() {
  if (!enabled()) return { ok: false, enabled: false, reason: 'disabled', url: config.codingBrainUrl };
  try {
    const data = await request(`${config.codingBrainUrl}/health`, {}, Math.min(1500, config.codingBrainTimeoutMs));
    return { enabled: true, url: config.codingBrainUrl, ...data };
  } catch (error) {
    return { ok: false, enabled: true, url: config.codingBrainUrl, error: error.message };
  }
}

async function run(message, options = {}) {
  const task = String(message || '').trim();
  if (!task) throw new Error('Coding task is required.');
  const workspace = resolveWorkspace(task, options.workspace);
  const mode = options.mode || modeFor(task);
  const host = ['0.0.0.0', '::', '[::]'].includes(String(config.host).toLowerCase()) ? '127.0.0.1' : config.host;
  return request(`${config.codingBrainUrl}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task, workspace, mode, mark3Url: `http://${host}:${config.port}` }),
  }, config.codingBrainTimeoutMs);
}

function validationLabel(validation) {
  if (!validation || validation.status === 'not-run') return 'No project validation script was available.';
  if (validation.passed) return 'Validation passed.';
  return 'Validation found a failure.';
}

function summarize(result) {
  if (!result) return 'The Coding Brain returned no result.';
  if (result.mode === 'plan' || result.mode === 'inspect') {
    const summary = String(result.plan?.summary || 'I inspected the codebase and built a plan.').trim();
    const files = Array.isArray(result.selectedFiles) ? result.selectedFiles.length : 0;
    return `${summary}${files ? ` I narrowed it to ${files} relevant file${files === 1 ? '' : 's'}.` : ''}`;
  }
  const changed = Array.isArray(result.changedFiles) ? result.changedFiles.length : 0;
  const review = String(result.review?.verdict || 'unknown');
  const base = String(result.summary || 'The coding task is complete.').trim();
  const reviewLine = review === 'pass' ? 'The independent review passed.' : review === 'needs_changes' ? 'The reviewer still found issues that need attention.' : 'The review result was inconclusive.';
  return `${base} I changed ${changed} file${changed === 1 ? '' : 's'}. ${validationLabel(result.validation)} ${reviewLine}`.replace(/\s+/g, ' ').trim();
}

module.exports = { enabled, shouldUse, modeFor, resolveWorkspace, health, run, summarize };
