import process from 'node:process';
import net from 'node:net';
import { spawn } from 'node:child_process';

const enabled = !/^(0|false|no|off)$/i.test(String(process.env.ULTRON_ENABLE_OPENCODE ?? '1'));
const port = Number(process.env.OPENCODE_PORT || 4096);
const host = process.env.OPENCODE_HOST || '127.0.0.1';
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

async function waitForPort(timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await isPortOpen()) return true;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

function cleanup() {
  if (child && !child.killed) {
    try { child.kill(); } catch {}
  }
}

async function main() {
  if (!enabled) {
    console.log('[OpenCode] Disabled for unified Mark 2 startup. Set ULTRON_ENABLE_OPENCODE=1 to enable.');
    return;
  }

  if (await isPortOpen()) {
    console.log(`[OpenCode] Existing local server detected at http://${host}:${port}.`);
    return;
  }

  console.log(`[OpenCode] Starting local model server at http://${host}:${port} ...`);
  child = spawn('opencode', ['serve', '--hostname', host, '--port', String(port)], {
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
  });
  child.once('error', (error) => console.error(`[OpenCode] Process error: ${error.message}`));
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);
  child.unref();

  const ready = await waitForPort();
  if (!ready) throw new Error(`OpenCode local server did not become reachable at http://${host}:${port}. Ensure the 'opencode' command is installed and on PATH.`);
  console.log(`[OpenCode] Local server ready at http://${host}:${port}.`);
}

main().catch((error) => { console.error(`[Unified Start] ${error.message}`); process.exit(1); });
