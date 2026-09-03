const path = require('path');
const { spawn } = require('child_process');
const omniRoute = require('../../core/omniroute');
const config = require('./config');

const READY_TIMEOUT_MS = Math.max(20000, Number(process.env.ULTRON_M3_OMNIROUTE_LAZY_TIMEOUT_MS || 75000));
const POLL_MS = Math.max(250, Number(process.env.ULTRON_M3_OMNIROUTE_LAZY_POLL_MS || 900));
let inflight = null;
let lastSpawnAt = 0;

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
  const script = path.join(config.mark3Root, 'scripts', 'start-mark3.mjs');
  const envFile = path.join(config.projectRoot, '.env');
  const child = spawn(process.execPath, [`--env-file=${envFile}`, script], {
    cwd: config.mark3Root,
    env: process.env,
    windowsHide: true,
    detached: true,
    stdio: 'ignore',
    shell: false,
  });
  child.once('error', (error) => {
    console.warn(`[Mark 3] Lazy OmniRoute process could not start: ${error.message}`);
  });
  child.unref();
  lastSpawnAt = Date.now();
}

async function ensure({ reason = 'direct providers unavailable' } = {}) {
  if (await ready()) return { ok: true, alreadyRunning: true, started: false };
  if (inflight) return inflight;

  inflight = (async () => {
    console.warn(`[Mark 3] Direct model routes are unavailable (${reason}). Waking OmniRoute fallback now.`);
    // Avoid repeatedly spawning while a previous detached launcher is still booting.
    if (!lastSpawnAt || Date.now() - lastSpawnAt > READY_TIMEOUT_MS) launch();

    const started = Date.now();
    while (Date.now() - started < READY_TIMEOUT_MS) {
      if (await ready()) {
        console.log(`[Mark 3] OmniRoute fallback is ready after ${Date.now() - started} ms.`);
        return { ok: true, alreadyRunning: false, started: true, latencyMs: Date.now() - started };
      }
      await sleep(POLL_MS);
    }
    const error = new Error(`OmniRoute fallback did not become ready within ${Math.round(READY_TIMEOUT_MS / 1000)} seconds.`);
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
    starting: Boolean(inflight),
    lastSpawnAt: lastSpawnAt || null,
  };
}

module.exports = { ensure, ready, status };
