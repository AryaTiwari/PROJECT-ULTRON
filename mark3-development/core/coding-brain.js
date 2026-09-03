const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('./config');

let managedChild = null;
let startupPromise = null;
let runtimeDir = null;
let lastStartError = null;
let startOnNextHealth = false;
let runtimeRefreshStatus = null;

function enabled() {
  return config.codingBrainEnabled;
}

function shouldUse(message, taskType) {
  if (!enabled()) return false;
  const text = String(message || '').toLowerCase();
  const task = String(taskType || '').toLowerCase();
  const action = /\b(?:fix|implement|add|change|update|modify|edit|refactor|remove|delete|create|build|debug|investigate|inspect|review|test|repair|optimi[sz]e)\b/.test(text);
  const codeSignal = /\b(?:repo|repository|codebase|source|branch|commit|file|function|class|component|server|api|endpoint|route|website|app|interface|frontend|backend|database|module|service|feature|screen|page|project|ultron|elevate|bug|code)\b/.test(text);
  const selected = task === 'coding' ? action : action && codeSignal;
  if (selected) startOnNextHealth = true;
  return selected;
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

function candidateDirs() {
  const values = [];
  if (config.codingBrainDir) values.push(path.resolve(config.codingBrainDir));
  values.push(path.resolve(config.projectRoot, '..', 'CODING-AGENT-BRAIN'));
  values.push(path.resolve(config.projectRoot, '.ultron', 'coding-brain'));
  return [...new Set(values)];
}

function validRuntime(dir) {
  return Boolean(dir && fs.existsSync(path.join(dir, 'ultron-cortex', 'server.mjs')));
}

function findRuntimeDir() {
  for (const dir of candidateDirs()) if (validRuntime(dir)) return dir;
  return null;
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || config.projectRoot,
      env: options.env || process.env,
      windowsHide: true,
      stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { if (stdout.length < 12000) stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { if (stderr.length < 12000) stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with code ${code}${stderr.trim() ? `: ${stderr.trim().slice(-1200)}` : ''}`));
    });
  });
}

async function refreshRuntime(dir) {
  const gitDir = path.join(dir, '.git');
  if (!fs.existsSync(gitDir)) return { attempted: false, updated: false, reason: 'not-a-git-clone' };
  try {
    const branch = (await runProcess('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir })).stdout.trim();
    if (branch !== 'main') return { attempted: false, updated: false, reason: `branch-${branch || 'unknown'}` };
    const dirty = (await runProcess('git', ['status', '--porcelain'], { cwd: dir })).stdout.trim();
    if (dirty) return { attempted: false, updated: false, reason: 'local-changes-present' };
    const before = (await runProcess('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
    await runProcess('git', ['fetch', '--quiet', 'origin', 'main'], { cwd: dir });
    await runProcess('git', ['merge', '--ff-only', '--quiet', 'FETCH_HEAD'], { cwd: dir });
    const after = (await runProcess('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
    return { attempted: true, updated: Boolean(before && after && before !== after), before: before || null, after: after || null, reason: before === after ? 'already-current' : 'fast-forwarded' };
  } catch (error) {
    return { attempted: true, updated: false, reason: 'refresh-failed', error: error.message };
  }
}

async function provisionRuntime() {
  const existing = findRuntimeDir();
  if (existing) {
    runtimeRefreshStatus = await refreshRuntime(existing);
    if (runtimeRefreshStatus.reason === 'local-changes-present') {
      console.warn(`[Mark 3] Coding Brain at ${existing} has local changes; auto-update skipped safely.`);
    } else if (runtimeRefreshStatus.reason === 'refresh-failed') {
      console.warn(`[Mark 3] Coding Brain auto-update failed; using the existing runtime: ${runtimeRefreshStatus.error}`);
    } else if (runtimeRefreshStatus.updated) {
      console.log(`[Mark 3] Coding Brain auto-updated ${String(runtimeRefreshStatus.before).slice(0, 8)} -> ${String(runtimeRefreshStatus.after).slice(0, 8)}.`);
    }
    return existing;
  }
  if (!config.codingBrainAutoProvision) throw new Error('Coding Brain runtime was not found and auto-provisioning is disabled.');

  const target = path.resolve(config.projectRoot, '.ultron', 'coding-brain');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target) && !validRuntime(target)) fs.rmSync(target, { recursive: true, force: true });
  await runProcess('git', ['clone', '--depth', '1', '--branch', 'main', config.codingBrainRepo, target], { cwd: config.projectRoot });
  if (!validRuntime(target)) throw new Error('Coding Brain repository was cloned but ultron-cortex/server.mjs is missing.');
  runtimeRefreshStatus = { attempted: true, updated: true, reason: 'provisioned-new-clone' };
  return target;
}

function brainPort() {
  try {
    const url = new URL(config.codingBrainUrl);
    return Number(url.port || 8791);
  } catch {
    return 8791;
  }
}

async function rawHealth() {
  if (!enabled()) return { ok: false, enabled: false, reason: 'disabled', url: config.codingBrainUrl, managed: false };
  try {
    const data = await request(`${config.codingBrainUrl}/health`, {}, Math.min(1500, config.codingBrainTimeoutMs));
    return {
      enabled: true,
      url: config.codingBrainUrl,
      managed: Boolean(managedChild && !managedChild.killed),
      runtimeDir: runtimeDir || findRuntimeDir(),
      runtimeRefresh: runtimeRefreshStatus,
      ...data,
    };
  } catch (error) {
    return {
      ok: false,
      enabled: true,
      url: config.codingBrainUrl,
      managed: Boolean(managedChild && !managedChild.killed),
      runtimeDir: runtimeDir || findRuntimeDir(),
      runtimeRefresh: runtimeRefreshStatus,
      standby: config.codingBrainAutoStart,
      error: error.message,
      lastStartError,
    };
  }
}

async function waitUntilHealthy(timeoutMs = config.codingBrainStartupTimeoutMs) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await rawHealth();
    if (last.ok) return last;
    if (managedChild && managedChild.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(last?.error || `Coding Brain did not become ready within ${timeoutMs}ms.`);
}

async function startManagedRuntime() {
  if (!enabled()) throw new Error('Coding Brain is disabled.');
  const current = await rawHealth();
  if (current.ok) return current;
  if (!config.codingBrainAutoStart) throw new Error('Coding Brain is offline and auto-start is disabled.');
  if (startupPromise) return startupPromise;

  startupPromise = (async () => {
    try {
      runtimeDir = await provisionRuntime();
      const serverFile = path.join(runtimeDir, 'ultron-cortex', 'server.mjs');
      const logDir = path.resolve(config.projectRoot, '.ultron');
      fs.mkdirSync(logDir, { recursive: true });
      const logPath = path.join(logDir, 'coding-brain.log');
      const log = fs.openSync(logPath, 'a');
      managedChild = spawn(process.execPath, [serverFile], {
        cwd: runtimeDir,
        env: {
          ...process.env,
          ULTRON_CODING_BRAIN_HOST: '127.0.0.1',
          ULTRON_CODING_BRAIN_PORT: String(brainPort()),
          ULTRON_MARK3_URL: `http://127.0.0.1:${config.port}`,
        },
        windowsHide: true,
        stdio: ['ignore', log, log],
        shell: false,
      });
      try { fs.closeSync(log); } catch {}
      managedChild.once('exit', (code, signal) => {
        if (code !== 0 && code !== null) lastStartError = `Coding Brain process exited with code ${code}${signal ? ` (${signal})` : ''}.`;
        managedChild = null;
      });
      managedChild.once('error', (error) => { lastStartError = error.message; });
      const ready = await waitUntilHealthy();
      lastStartError = null;
      return { ...ready, autoStarted: true, logPath, runtimeRefresh: runtimeRefreshStatus };
    } catch (error) {
      lastStartError = error.message;
      throw error;
    } finally {
      startupPromise = null;
    }
  })();
  return startupPromise;
}

async function ensureRunning() {
  startOnNextHealth = false;
  const current = await rawHealth();
  if (current.ok) return current;
  return startManagedRuntime();
}

async function health() {
  const demanded = startOnNextHealth;
  startOnNextHealth = false;
  const current = await rawHealth();
  if (current.ok || !demanded || !config.codingBrainAutoStart) return current;
  try {
    return await startManagedRuntime();
  } catch (error) {
    return { ...current, ok: false, autoStartFailed: true, error: error.message, lastStartError: error.message };
  }
}

async function run(message, options = {}) {
  const task = String(message || '').trim();
  if (!task) throw new Error('Coding task is required.');
  await ensureRunning();
  const workspace = resolveWorkspace(task, options.workspace);
  const mode = options.mode || modeFor(task);
  const host = ['0.0.0.0', '::', '[::]'].includes(String(config.host).toLowerCase()) ? '127.0.0.1' : config.host;
  return request(`${config.codingBrainUrl}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task, workspace, mode, mark3Url: `http://${host}:${config.port}` }),
  }, config.codingBrainTimeoutMs);
}

function validationLabel(result) {
  const validation = result?.validation;
  const level = result?.reliability?.verificationLevel;
  if (level === 'verified-current-tree') return 'Validation passed against the exact current working tree.';
  if (!validation || validation.status === 'not-run') return 'No executable project validation script was available; the result is reviewed but not test-proven.';
  if (validation.passed) return 'Validation passed, but no fresh working-tree evidence was recorded.';
  return 'Validation found a failure.';
}

function summarize(result) {
  if (!result) return 'The Coding Brain returned no result.';
  if (result.mode === 'plan' || result.mode === 'inspect') {
    const summary = String(result.plan?.summary || 'I inspected the codebase and built a plan.').trim();
    const files = Array.isArray(result.selectedFiles) ? result.selectedFiles.length : 0;
    const specialist = result.investigation ? ' I ran a root-cause investigation first.' : result.planningCouncil ? ' I ran the planning council first.' : '';
    return `${summary}${files ? ` I narrowed it to ${files} relevant file${files === 1 ? '' : 's'}.` : ''}${specialist}`;
  }
  const changed = Array.isArray(result.changedFiles) ? result.changedFiles.length : 0;
  const review = String(result.review?.verdict || 'unknown');
  const base = String(result.summary || 'The coding task is complete.').trim();
  const reviewLine = review === 'pass' ? 'The independent review passed.' : review === 'needs_changes' ? 'The reviewer still found issues that need attention.' : 'The review result was inconclusive.';
  return `${base} I changed ${changed} file${changed === 1 ? '' : 's'}. ${validationLabel(result)} ${reviewLine}`.replace(/\s+/g, ' ').trim();
}

module.exports = { enabled, shouldUse, modeFor, resolveWorkspace, health, ensureRunning, run, summarize };
