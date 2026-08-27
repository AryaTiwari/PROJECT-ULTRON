import process from 'node:process';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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

function resolveOpenCodeCommand() {
  const candidates = [];
  const explicit = process.env.OPENCODE_BIN;
  if (explicit) candidates.push(explicit);

  if (process.platform === 'win32') {
    try {
      const result = spawnSync('where.exe', ['opencode'], { encoding: 'utf8', windowsHide: true });
      if (result.status === 0) {
        for (const line of String(result.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)) candidates.push(line);
      }
    } catch {}

    const appData = process.env.APPDATA || '';
    const localAppData = process.env.LOCALAPPDATA || '';
    const userProfile = process.env.USERPROFILE || process.env.HOME || '';
    candidates.push(
      path.join(appData, 'npm', 'opencode.cmd'),
      path.join(appData, 'npm', 'opencode.exe'),
      path.join(localAppData, 'Programs', 'opencode', 'opencode.exe'),
      path.join(userProfile, '.opencode', 'bin', 'opencode.exe'),
    );
  } else {
    candidates.push('/usr/local/bin/opencode', '/usr/bin/opencode', path.join(process.env.HOME || '', '.opencode', 'bin', 'opencode'));
  }

  return candidates.find((candidate) => candidate && (path.isAbsolute(candidate) ? fs.existsSync(candidate) : true)) || null;
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

  const command = resolveOpenCodeCommand();
  if (!command) {
    throw new Error('OpenCode is installed for the interactive shell, but the executable could not be resolved by Node. Set OPENCODE_BIN to the full path of opencode.cmd/opencode.exe.');
  }

  console.log(`[OpenCode] Starting local model server at http://${host}:${port} using ${command}`);
  child = spawn(command, ['serve', '--hostname', host, '--port', String(port)], {
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
    shell: false,
  });
  child.once('error', (error) => console.error(`[OpenCode] Process error: ${error.message}`));
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);
  child.unref();

  const ready = await waitForPort();
  if (!ready) throw new Error(`OpenCode local server did not become reachable at http://${host}:${port}.`);
  console.log(`[OpenCode] Local server ready at http://${host}:${port}.`);
}

main().catch((error) => { console.error(`[Unified Start] ${error.message}`); process.exit(1); });
