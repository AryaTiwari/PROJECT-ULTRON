import process from 'node:process';

const enableOmniRoute = /^(1|true|yes|on)$/i.test(String(process.env.ULTRON_ENABLE_OMNIROUTE || ''));

if (!enableOmniRoute) {
  console.log('[OmniRoute] Disabled for unified Mark 2 startup. Direct model fabric is active. Set ULTRON_ENABLE_OMNIROUTE=1 to enable legacy gateway fallback.');
  process.exit(0);
}

import net from 'node:net';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.env.OMNIROUTE_PORT || 20128);
const host = process.env.OMNIROUTE_HOST || '127.0.0.1';
const configuredDir = process.env.OMNIROUTE_DIR;
const defaultDir = process.platform === 'win32' && process.env.USERPROFILE
  ? path.join(process.env.USERPROFILE, 'Downloads', 'OmniRoute-release-v3.8.51', 'OmniRoute-release-v3.8.51')
  : '';
const omniDir = configuredDir || defaultDir;
let child = null;

function isPortOpen() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(800, () => done(false));
  });
}

async function waitForPort(timeoutMs = 120000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await isPortOpen()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function cleanup() {
  if (child && !child.killed) {
    try { child.kill(); } catch {}
  }
}

async function main() {
  if (await isPortOpen()) {
    console.log(`[OmniRoute] Existing gateway detected at http://${host}:${port}.`);
    return;
  }
  if (!omniDir || !fs.existsSync(path.join(omniDir, 'package.json'))) {
    throw new Error('OmniRoute is not running and its directory could not be found.');
  }
  const runNext = path.join(omniDir, 'scripts', 'dev', 'run-next.mjs');
  if (!fs.existsSync(runNext)) throw new Error(`OmniRoute dev launcher not found at ${runNext}.`);
  console.log(`[OmniRoute] Starting legacy gateway from ${omniDir}`);
  child = spawn(process.execPath, ['--max-old-space-size=8192', runNext, 'dev'], { cwd: omniDir, stdio: 'ignore', detached: true, windowsHide: true });
  child.once('error', (error) => console.error(`[OmniRoute] Process error: ${error.message}`));
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);
  child.unref();
  const ready = await waitForPort();
  if (!ready) {
    cleanup();
    throw new Error(`OmniRoute did not become reachable at http://${host}:${port} within 120 seconds.`);
  }
  console.log(`[OmniRoute] Legacy gateway ready at http://${host}:${port}.`);
}

main().catch((error) => { console.error(`[Unified Start] ${error.message}`); process.exit(1); });
