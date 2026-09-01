import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

const HOST = process.env.OMNIROUTE_HOST || '127.0.0.1';
const PORT = Number(process.env.OMNIROUTE_PORT || 20128);
const ROOT = path.resolve(process.cwd(), '..', '..');
const OMNI_DIR = process.env.OMNIROUTE_DIR || path.join(ROOT, 'Downloads', 'OmniRoute-release-v3.8.51', 'OmniRoute-release-v3.8.51');
const LOG_DIR = path.resolve(process.env.ULTRON_RUNTIME_LOG_DIR || path.join(ROOT, '.ultron'));
const LOG_FILE = path.join(LOG_DIR, 'mark3-omniroute.log');
const ENTRY = path.join(OMNI_DIR, 'scripts', 'dev', 'run-next.mjs');
const MEMORY_MB = Number(process.env.OMNIROUTE_MEMORY_MB || 4096);
const TURBOPACK = process.env.OMNIROUTE_USE_TURBOPACK || '1';

function isOpen(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(900, () => done(false));
  });
}

async function waitForGateway(timeoutMs = 180000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await isOpen(HOST, PORT)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function tail(file, lines = 60) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(-lines).join('\n').trim(); } catch { return ''; }
}

if (await isOpen(HOST, PORT)) {
  console.log(`[Mark 3] OmniRoute already listening at http://${HOST}:${PORT}.`);
  process.exit(0);
}

if (!fs.existsSync(ENTRY)) {
  console.error(`[Mark 3] OmniRoute entry not found: ${ENTRY}`);
  console.error('[Mark 3] Set OMNIROUTE_DIR in the parent .env if your OmniRoute installation is elsewhere.');
  process.exit(1);
}

fs.mkdirSync(LOG_DIR, { recursive: true });
try { fs.writeFileSync(LOG_FILE, '', 'utf8'); } catch {}
const log = fs.openSync(LOG_FILE, 'a');
const env = {
  ...process.env,
  PORT: String(PORT),
  HOST,
  OMNIROUTE_USE_TURBOPACK: TURBOPACK,
  OMNIROUTE_MEMORY_MB: String(MEMORY_MB),
  OMNIROUTE_SKIP_DB_HEALTHCHECK: process.env.OMNIROUTE_SKIP_DB_HEALTHCHECK || '1',
  NEXT_TELEMETRY_DISABLED: '1',
};

console.log(`[Mark 3] Starting OmniRoute at http://${HOST}:${PORT}.`);
console.log(`[Mark 3] OmniRoute mode: ${TURBOPACK === '1' ? 'Turbopack' : 'Webpack'}; V8 heap: ${MEMORY_MB} MB.`);
console.log(`[Mark 3] OmniRoute logs: ${LOG_FILE}`);

const child = spawn(process.execPath, [`--max-old-space-size=${MEMORY_MB}`, ENTRY, 'dev'], {
  cwd: OMNI_DIR,
  env,
  windowsHide: process.platform === 'win32',
  detached: true,
  shell: false,
  stdio: ['ignore', log, log],
});
child.unref();
try { fs.closeSync(log); } catch {}

const ready = await waitForGateway();
if (!ready) {
  console.error(`[Mark 3] OmniRoute failed to become reachable within 180 seconds.`);
  const output = tail(LOG_FILE);
  if (output) console.error(`\nLast OmniRoute output:\n${output}`);
  process.exit(1);
}

console.log(`[Mark 3] OmniRoute ready at http://${HOST}:${PORT}.`);
