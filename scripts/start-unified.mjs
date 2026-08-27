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

function classifyCommand(command) {
  const lower = String(command || '').toLowerCase();
  if (process.platform === 'win32' && (lower.endsWith('.cmd') || lower.endsWith('.bat'))) return 'cmd';
  return 'direct';
}

function resolveOpenCodeCommand() {
  const candidates = [];
  const explicit = process.env.OPENCODE_BIN;
  if (explicit) candidates.push({ kind: classifyCommand(explicit), command: explicit });

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || '';
    const localAppData = process.env.LOCALAPPDATA || '';
    const userProfile = process.env.USERPROFILE || process.env.HOME || '';
    const shimCandidates = [
      path.join(appData, 'npm', 'opencode.cmd'),
      path.join(appData, 'npm', 'opencode.CMD'),
      path.join(appData, 'npm', 'opencode.exe'),
      path.join(localAppData, 'Programs', 'opencode', 'opencode.exe'),
      path.join(userProfile, '.opencode', 'bin', 'opencode.exe'),
    ];
    for (const candidate of shimCandidates) {
      if (candidate && fs.existsSync(candidate)) candidates.push({ kind: classifyCommand(candidate), command: candidate });
    }

    // npm-installed CLIs are reliably invokable through cmd.exe on Windows.
    for (const name of ['opencode.cmd', 'opencode']) candidates.push({ kind: classifyCommand(name), command: name });

    try {
      const result = spawnSync('where.exe', ['opencode.cmd'], { encoding: 'utf8', windowsHide: true });
      if (result.status === 0) {
        for (const line of String(result.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
          candidates.unshift({ kind: classifyCommand(line), command: line });
        }
      }
    } catch {}
  } else {
    for (const candidate of ['/usr/local/bin/opencode', '/usr/bin/opencode', path.join(process.env.HOME || '', '.opencode', 'bin', 'opencode')]) {
      if (fs.existsSync(candidate)) candidates.push({ kind: 'direct', command: candidate });
    }
    candidates.push({ kind: 'direct', command: 'opencode' });
  }

  const seen = new Set();
  return candidates.find((candidate) => {
    const key = `${candidate.kind}:${candidate.command}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }) || null;
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

  const resolved = resolveOpenCodeCommand();
  if (!resolved) {
    throw new Error('OpenCode is installed for the interactive shell, but the executable could not be resolved by Node. Set OPENCODE_BIN to the full path of opencode.cmd/opencode.exe.');
  }

  console.log(`[OpenCode] Starting local model server at http://${host}:${port} using ${resolved.command}`);
  const args = ['serve', '--hostname', host, '--port', String(port)];
  if (resolved.kind === 'cmd') {
    child = spawn('cmd.exe', ['/d', '/c', resolved.command, ...args], {
      stdio: 'ignore', detached: true, windowsHide: true, shell: false,
    });
  } else {
    child = spawn(resolved.command, args, {
      stdio: 'ignore', detached: true, windowsHide: true, shell: false,
    });
  }

  child.once('error', (error) => console.error(`[OpenCode] Process error: ${error.message}`));
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);
  child.unref();

  const ready = await waitForPort();
  if (!ready) throw new Error(`OpenCode local server did not become reachable at http://${host}:${port}.`);
  console.log(`[OpenCode] Local server ready at http://${host}:${port}.`);
}

main().catch((error) => { console.error(`[Unified Start] ${error.message}`); process.exit(1); });
