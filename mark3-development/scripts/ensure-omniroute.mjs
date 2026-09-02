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
const LOCK_FILE = path.join(LOG_DIR, 'mark3-omniroute.lock');
const ENTRY = path.join(OMNI_DIR, 'scripts', 'dev', 'run-next.mjs');
const MEMORY_MB = Number(process.env.OMNIROUTE_MEMORY_MB || 4096);
// Turbopack can create a noisy child-process tree on Windows. OmniRoute documents
// webpack as the Windows fallback, so keep Mark 3 quiet/stable there while still
// allowing the existing environment override on non-Windows systems.
const TURBOPACK = process.platform === 'win32'
  ? '0'
  : (process.env.OMNIROUTE_USE_TURBOPACK || '1');

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

function tail(file, lines = 80) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(-lines).join('\n').trim(); } catch { return ''; }
}

function readLock() {
  try { return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); } catch { return null; }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function clearStaleLock() {
  const lock = readLock();
  if (!lock) return;
  if (pidAlive(Number(lock.pid))) return;
  try { fs.unlinkSync(LOCK_FILE); } catch {}
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
clearStaleLock();

const existingLock = readLock();
if (existingLock && pidAlive(Number(existingLock.pid))) {
  console.log(`[Mark 3] OmniRoute launcher already active (pid=${existingLock.pid}); waiting for ${HOST}:${PORT}.`);
  const ready = await waitForGateway();
  if (ready) {
    console.log(`[Mark 3] OmniRoute ready at http://${HOST}:${PORT}.`);
    process.exit(0);
  }
  console.error(`[Mark 3] Existing OmniRoute launcher process ${existingLock.pid} did not make the gateway ready.`);
  process.exit(1);
}

const tempLock = `${LOCK_FILE}.${process.pid}.tmp`;
try {
  fs.writeFileSync(tempLock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), host: HOST, port: PORT }, null, 2), 'utf8');
  fs.renameSync(tempLock, LOCK_FILE);
} catch {
  try { fs.unlinkSync(tempLock); } catch {}
}

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
  DEVIN_AGENTIC_HOME: process.env.DEVIN_AGENTIC_HOME || '/home/bridge',
  DEVIN_AGENTIC_ACP_TIMEOUT_MS: process.env.DEVIN_AGENTIC_ACP_TIMEOUT_MS || '120000',
};

console.log(`[Mark 3] Starting OmniRoute at http://${HOST}:${PORT}.`);
console.log(`[Mark 3] OmniRoute mode: ${TURBOPACK === '1' ? 'Turbopack' : 'Webpack'}; V8 heap: ${MEMORY_MB} MB.`);
console.log(`[Mark 3] Devin bridge sandbox home: ${env.DEVIN_AGENTIC_HOME}.`);
console.log(`[Mark 3] OmniRoute logs: ${LOG_FILE}`);

let child;
try {
  const childOptions = {
    cwd: OMNI_DIR,
    env,
    detached: true,
    windowsHide: true,
    shell: false,
    stdio: ['ignore', log, log],
  };
  child = spawn(process.execPath, [`--max-old-space-size=${MEMORY_MB}`, ENTRY, 'dev'], childOptions);
  child.unref();
} catch (error) {
  try { fs.unlinkSync(LOCK_FILE); } catch {}
  try { fs.closeSync(log); } catch {}
  console.error(`[Mark 3] Failed to spawn OmniRoute: ${error?.message || String(error)}`);
  process.exit(1);
}
try { fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString(), host: HOST, port: PORT }, null, 2), 'utf8'); } catch {}
try { fs.closeSync(log); } catch {}

const ready = await waitForGateway();
if (!ready) {
  console.error(`[Mark 3] OmniRoute failed to become reachable within 180 seconds.`);
  const output = tail(LOG_FILE);
  if (output) console.error(`\nLast OmniRoute output:\n${output}`);
  process.exit(1);
}

console.log(`[Mark 3] OmniRoute ready at http://${HOST}:${PORT}.`);
