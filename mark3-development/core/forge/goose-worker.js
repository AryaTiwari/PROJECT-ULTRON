const { spawn, spawnSync } = require('child_process');
const governor = require('./model-governor');

const ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.ULTRON_M3_FORGE_GOOSE_ENABLED || '0'));
const MAX_TURNS = Math.max(4, Math.min(40, Number(process.env.ULTRON_M3_FORGE_GOOSE_MAX_TURNS || 16)));
const TIMEOUT_MS = Math.max(60_000, Number(process.env.ULTRON_M3_FORGE_GOOSE_TIMEOUT_MS || 15 * 60_000));
const MODEL = String(process.env.ULTRON_M3_FORGE_GOOSE_MODEL || 'poolside/laguna-xs-2.1').trim();

function installed() {
  try {
    const result = spawnSync('goose', ['--version'], { windowsHide: true, timeout: 5000, encoding: 'utf8' });
    return result.status === 0;
  } catch { return false; }
}
function enabled() { return ENABLED; }
function status() {
  return {
    enabled: ENABLED,
    installed: installed(),
    model: MODEL,
    provider: 'nvidia',
    maxTurns: MAX_TURNS,
    requiredApi: 'NVIDIA_API_KEY',
    separateGooseApiRequired: false,
    defaultWorker: false,
  };
}
function changedFiles(workspace) {
  try {
    const result = spawnSync('git', ['status', '--porcelain'], { cwd: workspace, windowsHide: true, timeout: 10000, encoding: 'utf8' });
    if (result.status !== 0) return [];
    return String(result.stdout || '').split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).trim()).filter(Boolean);
  } catch { return []; }
}
function runProcess(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('goose', args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch {}
      reject(new Error(`Goose worker timed out after ${TIMEOUT_MS}ms.`));
    }, TIMEOUT_MS);
    child.stdout?.on('data', (chunk) => { if (stdout.length < 160000) stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { if (stderr.length < 40000) stderr += String(chunk); });
    child.once('error', (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); reject(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Goose exited with code ${code}${stderr.trim() ? `: ${stderr.trim().slice(-1600)}` : ''}`));
    });
  });
}
async function run(task, options = {}) {
  if (!ENABLED) throw new Error('FORGE_GOOSE_DISABLED: Goose is opt-in and currently disabled.');
  if (!installed()) throw new Error('FORGE_GOOSE_NOT_INSTALLED: goose CLI is not available on PATH.');
  const keys = governor.keyRows();
  if (!keys.length) throw new Error('FORGE_NO_NVIDIA_KEY: Goose worker needs the same NVIDIA key used by Forge.');
  const key = keys[0];
  const workspace = options.workspace;
  const before = new Set(changedFiles(workspace));
  // Reserve a conservative budget before allowing an external multi-turn harness to call the API.
  governor.reserveExternalUsage(options.missionId, `goose:${MODEL}`, key.slot, {
    calls: MAX_TURNS,
    inputTokens: MAX_TURNS * 5000,
    outputTokens: MAX_TURNS * 2500,
    totalTokens: MAX_TURNS * 7500,
  });
  const env = {
    ...process.env,
    GOOSE_PROVIDER: 'nvidia',
    GOOSE_MODEL: MODEL,
    GOOSE_MODE: 'auto',
    NVIDIA_API_KEY: key.value,
    // Compatibility values for older Goose OpenAI-compatible NVIDIA setups.
    OPENAI_API_KEY: key.value,
    OPENAI_HOST: 'https://integrate.api.nvidia.com',
    OPENAI_BASE_URL: 'v1/chat/completions',
  };
  const args = ['run', '--no-session', '--with-builtin', 'developer', '--max-turns', String(MAX_TURNS), '--model', MODEL, '-t', String(task || '')];
  const result = await runProcess(args, { cwd: workspace, env });
  const after = changedFiles(workspace);
  const touched = after.filter((file) => !before.has(file) || before.has(file));
  return {
    ok: true,
    worker: 'goose',
    provider: 'nvidia',
    model: MODEL,
    summary: String(result.stdout || '').trim().slice(-12000) || 'Goose completed the assigned job.',
    changedFiles: [...new Set(touched)],
    stderr: String(result.stderr || '').trim().slice(-2000),
    budgetReservation: { calls: MAX_TURNS, tokens: MAX_TURNS * 7500 },
  };
}

module.exports = { enabled, installed, status, run, changedFiles };
