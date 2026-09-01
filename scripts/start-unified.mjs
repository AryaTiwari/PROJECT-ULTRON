import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { load: loadCredentials } = require('../core/credentials/local-store');

const openCodePort = Number(process.env.OPENCODE_PORT || 4096);
const openCodeHost = process.env.OPENCODE_HOST || '127.0.0.1';
const omniPort = Number(process.env.OMNIROUTE_PORT || 20128);
const omniHost = process.env.OMNIROUTE_HOST || '127.0.0.1';
const providerMode = String(process.env.ULTRON_MODEL_PROVIDER || 'omniroute').toLowerCase();
const openCodeEnabled = /^(1|true|yes|on)$/i.test(String(process.env.ULTRON_ENABLE_OPENCODE || '0')) || providerMode === 'opencode' || providerMode === 'opencode-server';
const omniDir = process.env.OMNIROUTE_DIR || (process.platform === 'win32' && process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Downloads', 'OmniRoute-release-v3.8.51', 'OmniRoute-release-v3.8.51') : '');
const configPath = path.resolve(process.env.ULTRON_OPENCODE_CONFIG || path.join(process.cwd(), '.ultron', 'opencode-omniroute.json'));
const logDir = path.resolve(process.env.ULTRON_RUNTIME_LOG_DIR || path.join(process.cwd(), '.ultron'));
const openCodeLog = path.join(logDir, 'opencode.log');
const omniLog = path.join(logDir, 'omniroute.log');
let openCodeChild = null;
let omniChild = null;

function isPortOpen(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(800, () => done(false));
  });
}

async function waitForPort(host, port, timeoutMs = 180000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await isPortOpen(host, port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function readTail(file, lines = 80) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.split(/\r?\n/).slice(-lines).join('\n').trim();
  } catch {
    return '';
  }
}

function killChild(child) { if (child && !child.killed) { try { child.kill(); } catch {} } }
function cleanup() { killChild(openCodeChild); killChild(omniChild); }

function resolveOpenCodeCommand() {
  const candidates = [];
  const explicit = process.env.OPENCODE_BIN;
  if (explicit) candidates.push({ kind: process.platform === 'win32' && /\.(cmd|bat)$/i.test(explicit) ? 'cmd' : 'direct', command: explicit });
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || ''; const localAppData = process.env.LOCALAPPDATA || ''; const userProfile = process.env.USERPROFILE || process.env.HOME || '';
    for (const candidate of [path.join(appData, 'npm', 'opencode.cmd'), path.join(appData, 'npm', 'opencode.CMD'), path.join(appData, 'npm', 'opencode.exe'), path.join(localAppData, 'Programs', 'opencode', 'opencode.exe'), path.join(userProfile, '.opencode', 'bin', 'opencode.exe')]) if (fs.existsSync(candidate)) candidates.push({ kind: /\.(cmd|bat)$/i.test(candidate) ? 'cmd' : 'direct', command: candidate });
    candidates.push({ kind: 'cmd', command: 'opencode.cmd' });
    try { const result = spawnSync('where.exe', ['opencode.cmd'], { encoding: 'utf8', windowsHide: true }); if (result.status === 0) for (const line of String(result.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)) candidates.unshift({ kind: 'cmd', command: line }); } catch {}
  } else candidates.push({ kind: 'direct', command: 'opencode' });
  const seen = new Set();
  return candidates.find((candidate) => { const key = `${candidate.kind}:${candidate.command}`; if (seen.has(key)) return false; seen.add(key); return true; }) || null;
}

function resolveOmniCommand() {
  if (!omniDir || !fs.existsSync(path.join(omniDir, 'package.json'))) return null;
  const entry = path.join(omniDir, 'scripts', 'dev', 'run-next.mjs');
  if (!fs.existsSync(entry)) return null;
  return { cwd: omniDir, entry };
}

async function ensureOmniRoute() {
  if (await isPortOpen(omniHost, omniPort)) { console.log(`[OmniRoute] Existing gateway detected at http://${omniHost}:${omniPort}.`); return; }
  const resolved = resolveOmniCommand(); if (!resolved) { console.warn('[OmniRoute] Gateway not found locally; continuing without local gateway startup.'); return; }
  console.log(`[OmniRoute] Starting gateway from ${resolved.cwd}`);
  fs.mkdirSync(logDir, { recursive: true });
  try { fs.writeFileSync(omniLog, '', 'utf8'); } catch {}
  const logHandle = fs.openSync(omniLog, 'a');
  const env = {
    ...process.env,
    PORT: String(omniPort),
    HOST: omniHost,
    OMNIROUTE_USE_TURBOPACK: process.env.OMNIROUTE_USE_TURBOPACK || '1',
    OMNIROUTE_MEMORY_MB: process.env.OMNIROUTE_MEMORY_MB || '4096',
    OMNIROUTE_SKIP_DB_HEALTHCHECK: process.env.OMNIROUTE_SKIP_DB_HEALTHCHECK || '1',
    NEXT_TELEMETRY_DISABLED: '1',
  };
  console.log(`[OmniRoute] Fast-start config: ${env.OMNIROUTE_USE_TURBOPACK === '1' ? 'Turbopack' : 'Webpack'}; V8 heap: ${env.OMNIROUTE_MEMORY_MB}MB; DB health check: ${env.OMNIROUTE_SKIP_DB_HEALTHCHECK === '1' ? 'skipped' : 'enabled'}.`);
  omniChild = spawn(process.execPath, [`--max-old-space-size=${env.OMNIROUTE_MEMORY_MB}`, resolved.entry, 'dev'], { cwd: resolved.cwd, env, windowsHide: process.platform === 'win32', detached: true, stdio: ['ignore', logHandle, logHandle], shell: false });
  omniChild.once('error', (error) => console.error(`[OmniRoute] Process error: ${error.message}`));
  omniChild.unref();
  try { fs.closeSync(logHandle); } catch {}
  waitForPort(omniHost, omniPort, 180000).then((ready) => {
    if (ready) console.log(`[OmniRoute] Gateway ready at http://${omniHost}:${omniPort}.`);
    else { const tail = readTail(omniLog); console.error(`[OmniRoute] Gateway did not become reachable within 180s. Check ${omniLog}.${tail ? `\nLast OmniRoute output:\n${tail}` : ''}`); }
  }).catch((error) => console.error(`[OmniRoute] Readiness monitor failed: ${error.message}`));
  console.log('[OmniRoute] Background startup launched; continuing ULTRON boot.');
}

async function ensureOpenCode() {
  if (await isPortOpen(openCodeHost, openCodePort)) return;
  const resolved = resolveOpenCodeCommand(); if (!resolved) throw new Error('OpenCode executable could not be resolved.');
  let apiKey = ''; try { const credentials = await loadCredentials(); apiKey = String(credentials.OMNIROUTE_API_KEY || process.env.OMNIROUTE_API_KEY || process.env.ULTRON_OMNIROUTE_API_KEY || '').trim(); } catch {}
  fs.mkdirSync(logDir, { recursive: true }); try { fs.writeFileSync(openCodeLog, '', 'utf8'); } catch {}
  const env = { ...process.env, OPENCODE_CONFIG: configPath }; if (apiKey) env.OMNIROUTE_API_KEY = apiKey;
  const args = ['serve', '--hostname', openCodeHost, '--port', String(openCodePort)];
  if (process.platform === 'win32') {
    const out = fs.openSync(openCodeLog, 'a');
    openCodeChild = spawn('cmd.exe', ['/d', '/s', '/c', `${String(resolved.command).replace(/%/g, '%%')} ${args.join(' ')}`], { cwd: process.cwd(), env, windowsHide: true, detached: true, stdio: ['ignore', out, out], shell: false });
    openCodeChild.unref(); try { fs.closeSync(out); } catch {}
  } else { openCodeChild = spawn(resolved.command, args, { cwd: process.cwd(), env, stdio: 'ignore', detached: true, shell: false }); openCodeChild.unref(); }
}

async function main() {
  process.once('SIGINT', cleanup); process.once('SIGTERM', cleanup); await ensureOmniRoute();
  if (openCodeEnabled) { await ensureOpenCode(); } else console.log('[OpenCode] Skipped; OmniRoute is the primary Mark 2 transport.');
}
main().catch((error) => { console.error(`[Unified Start] ${error.message}`); process.exit(1); });
