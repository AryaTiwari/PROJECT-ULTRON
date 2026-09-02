import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const mark3Dir = path.resolve(new URL('..', import.meta.url).pathname);
const host = process.env.OMNIROUTE_HOST || '127.0.0.1';
const port = Number(process.env.OMNIROUTE_PORT || 20128);
const omniDir = process.env.OMNIROUTE_DIR || (process.platform === 'win32' && process.env.USERPROFILE
  ? path.join(process.env.USERPROFILE, 'Downloads', 'OmniRoute-release-v3.8.51', 'OmniRoute-release-v3.8.51')
  : '');
const logDir = path.resolve(process.env.ULTRON_RUNTIME_LOG_DIR || path.join(mark3Dir, '.ultron'));
const logFile = path.join(logDir, 'omniroute.log');
let omniChild = null;

process.env.ULTRON_MODEL_PROVIDER = 'omniroute';
process.env.ULTRON_M3_DISABLE_OPENCODE = '1';
process.env.ULTRON_DISABLE_OPENCODE = '1';
process.env.ULTRON_ENABLE_OPENCODE = '0';

function isPortOpen() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(800, () => done(false));
  });
}

function resolveEntry() {
  if (!omniDir) return null;
  const entry = path.join(omniDir, 'scripts', 'dev', 'run-next.mjs');
  return fs.existsSync(path.join(omniDir, 'package.json')) && fs.existsSync(entry) ? { cwd: omniDir, entry } : null;
}

async function main() {
  if (await isPortOpen()) {
    console.log(`[Mark 3] Existing OmniRoute gateway detected at http://${host}:${port}.`);
    return;
  }

  const resolved = resolveEntry();
  if (!resolved) {
    console.warn('[Mark 3] OmniRoute gateway executable not found locally; continuing without starting it.');
    return;
  }

  fs.mkdirSync(logDir, { recursive: true });
  try { fs.writeFileSync(logFile, '', 'utf8'); } catch {}
  const handle = fs.openSync(logFile, 'a');
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: host,
    OMNIROUTE_USE_TURBOPACK: '0',
    NEXT_TELEMETRY_DISABLED: '1',
  };

  omniChild = spawn(process.execPath, ['--max-old-space-size=8192', resolved.entry, 'dev'], {
    cwd: resolved.cwd,
    env,
    windowsHide: process.platform === 'win32',
    detached: true,
    stdio: ['ignore', handle, handle],
    shell: false,
  });
  omniChild.once('error', (error) => console.error(`[Mark 3] OmniRoute process error: ${error.message}`));
  omniChild.unref();
  try { fs.closeSync(handle); } catch {}
  console.log(`[Mark 3] Started OmniRoute inference fabric on http://${host}:${port}.`);
}

main().catch((error) => {
  console.error(`[Mark 3] OmniRoute bootstrap failed: ${error.message}`);
  process.exit(1);
});
