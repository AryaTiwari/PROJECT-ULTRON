const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const omniRoute = require('../../core/omniroute');
const config = require('./config');

const READY_TIMEOUT_MS = Math.max(30000, Number(process.env.ULTRON_M3_OMNIROUTE_LAZY_TIMEOUT_MS || 180000));
const POLL_MS = Math.max(250, Number(process.env.ULTRON_M3_OMNIROUTE_LAZY_POLL_MS || 900));
const MAX_LAUNCH_ATTEMPTS = Math.max(1, Math.min(3, Number(process.env.ULTRON_M3_OMNIROUTE_LAZY_LAUNCH_ATTEMPTS || 2)));
const runtimeDir = path.join(config.projectRoot, '.ultron');
const launchLog = path.join(runtimeDir, 'omniroute-lazy-launch.log');
let inflight = null;
let lastSpawnAt = 0;
let lastStartError = null;
let launcherExited = false;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function ready() {
  try {
    const health = await omniRoute.health();
    return Boolean(health?.ok);
  } catch {
    return false;
  }
}

function launch() {
  fs.mkdirSync(runtimeDir, { recursive: true });
  const script = path.join(config.mark3Root, 'scripts', 'start-mark3.mjs');
  const envFile = path.join(config.projectRoot, '.env');
  const handle = fs.openSync(launchLog, 'a');
  launcherExited = false;
  lastStartError = null;
  const child = spawn(process.execPath, [`--env-file=${envFile}`, script], {
    cwd: config.mark3Root,
    env: process.env,
    windowsHide: true,
    detached: true,
    stdio: ['ignore', handle, handle],
    shell: false,
  });
  try { fs.closeSync(handle); } catch {}
  child.once('error', (error) => {
    lastStartError = error.message;
    launcherExited = true;
    lastSpawnAt = 0;
    console.warn(`[Mark 3] Lazy OmniRoute process could not start: ${error.message}`);
  });
  child.once('exit', (code, signal) => {
    launcherExited = true;
    if (code && code !== 0) lastStartError = `launcher exited with ${signal ? `signal ${signal}` : `code ${code}`}`;
    if (code && code !== 0) lastSpawnAt = 0;
  });
  child.unref();
  lastSpawnAt = Date.now();
  return child;
}

async function ensure({ reason = 'direct providers unavailable' } = {}) {
  if (await ready()) return { ok: true, alreadyRunning: true, started: false };
  if (inflight) return inflight;

  inflight = (async () => {
    console.warn(`[Mark 3] Direct model routes are unavailable (${reason}). Waking OmniRoute fallback now.`);
    const started = Date.now();
    let launchAttempts = 0;

    while (Date.now() - started < READY_TIMEOUT_MS) {
      if (await ready()) {
        console.log(`[Mark 3] OmniRoute fallback is ready after ${Date.now() - started} ms.`);
        return { ok: true, alreadyRunning: false, started: true, latencyMs: Date.now() - started, launchAttempts };
      }

      const noRecentLauncher = !lastSpawnAt || Date.now() - lastSpawnAt > Math.min(45000, READY_TIMEOUT_MS / 2);
      if (launchAttempts < MAX_LAUNCH_ATTEMPTS && (launchAttempts === 0 || launcherExited || noRecentLauncher)) {
        launchAttempts += 1;
        launcherExited = false;
        launch();
        console.warn(`[Mark 3] OmniRoute lazy launch attempt ${launchAttempts}/${MAX_LAUNCH_ATTEMPTS}. Log: ${launchLog}`);
      }
      await sleep(POLL_MS);
    }

    const detail = lastStartError ? ` Last launcher error: ${lastStartError}.` : '';
    const error = new Error(`OmniRoute fallback did not become ready within ${Math.round(READY_TIMEOUT_MS / 1000)} seconds.${detail} See ${launchLog} and ${path.join(runtimeDir, 'omniroute-production.log')}.`);
    error.code = 'OMNIROUTE_LAZY_START_TIMEOUT';
    throw error;
  })();

  try { return await inflight; }
  finally { inflight = null; }
}

function status() {
  return {
    mode: 'lazy-fallback',
    timeoutMs: READY_TIMEOUT_MS,
    maxLaunchAttempts: MAX_LAUNCH_ATTEMPTS,
    starting: Boolean(inflight),
    lastSpawnAt: lastSpawnAt || null,
    lastStartError,
    launchLog,
  };
}

module.exports = { ensure, ready, status };
