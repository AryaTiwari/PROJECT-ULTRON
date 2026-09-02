import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const mark3Dir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const projectRoot = path.resolve(mark3Dir, '..');
const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const credentialStore = require('../../core/credentials/local-store');

process.env.ULTRON_MODEL_PROVIDER = 'omniroute';
process.env.ULTRON_M3_DISABLE_OPENCODE = '1';
process.env.ULTRON_DISABLE_OPENCODE = '1';
process.env.ULTRON_ENABLE_OPENCODE = '0';

const modelRouter = require('../core/model-router');
const baseUrl = new URL(process.env.OMNIROUTE_BASE_URL || 'http://127.0.0.1:20128/v1');
const host = process.env.OMNIROUTE_HOST || baseUrl.hostname || '127.0.0.1';
const port = Number(process.env.OMNIROUTE_PORT || baseUrl.port || 20128);
const logDir = path.resolve(process.env.ULTRON_RUNTIME_LOG_DIR || path.join(projectRoot, '.ultron'));
const logFile = path.join(logDir, 'omniroute.log');
const readyTimeoutMs = Math.max(15000, Number(process.env.ULTRON_M3_OMNIROUTE_READY_TIMEOUT_MS || 120000));
const maxOldSpaceMb = Math.max(1024, Number(process.env.ULTRON_OMNIROUTE_MAX_OLD_SPACE_MB || 3072));
const requireReadyProvider = !/^(0|false|no|off)$/i.test(String(process.env.ULTRON_M3_REQUIRE_READY_PROVIDER || '1'));
const restartStaleGateway = !/^(0|false|no|off)$/i.test(String(process.env.ULTRON_M3_RESTART_STALE_OMNIROUTE || '1'));

function isLoopback() {
  const value = String(host).toLowerCase();
  return value === '127.0.0.1' || value === 'localhost' || value === '::1' || value === '[::1]';
}
function isPortOpen() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (value) => { try { socket.destroy(); } catch {} resolve(value); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(800, () => done(false));
  });
}
async function waitForPort(timeoutMs = readyTimeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await isPortOpen()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}
async function waitForPortClosed(timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!(await isPortOpen())) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}
function validOmniDir(candidate) {
  if (!candidate) return null;
  const resolved = path.resolve(candidate);
  const entry = path.join(resolved, 'scripts', 'dev', 'run-next.mjs');
  return fs.existsSync(path.join(resolved, 'package.json')) && fs.existsSync(entry) ? { cwd: resolved, entry } : null;
}
function scanDownloads() {
  const downloads = path.join(os.homedir(), 'Downloads');
  if (!fs.existsSync(downloads)) return [];
  const hits = [];
  const firstLevel = fs.readdirSync(downloads, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /omniroute/i.test(entry.name)).map((entry) => path.join(downloads, entry.name));
  for (const folder of firstLevel) {
    hits.push(folder);
    try { for (const nested of fs.readdirSync(folder, { withFileTypes: true })) if (nested.isDirectory()) hits.push(path.join(folder, nested.name)); }
    catch {}
  }
  return hits;
}
function resolveEntry() {
  const candidates = [process.env.OMNIROUTE_DIR, path.join(os.homedir(), 'Downloads', 'OmniRoute-release-v3.8.51', 'OmniRoute-release-v3.8.51'), ...scanDownloads()].filter(Boolean);
  for (const candidate of candidates) { const resolved = validOmniDir(candidate); if (resolved) return resolved; }
  return null;
}
function readTail(file, lines = 60) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(-lines).join('\n').trim(); }
  catch { return ''; }
}
async function resolveEndpointKey() {
  const envKey = String(process.env.OMNIROUTE_ENDPOINT_KEY || process.env.OMNIROUTE_API_KEY || process.env.ULTRON_OMNIROUTE_API_KEY || '').trim();
  if (envKey) return envKey;
  try {
    const stored = await credentialStore.load();
    return String(stored.OMNIROUTE_ENDPOINT_KEY || stored.OMNIROUTE_API_KEY || stored.ULTRON_OMNIROUTE_API_KEY || '').trim();
  } catch { return ''; }
}
async function verifyCatalog() {
  const key = await resolveEndpointKey();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const headers = key ? { Authorization: `Bearer ${key}` } : {};
    const response = await fetch(`${baseUrl.toString().replace(/\/$/, '')}/models`, { headers, signal: controller.signal });
    const raw = await response.text();
    if (!response.ok) throw new Error(`OmniRoute /models HTTP ${response.status}: ${raw.slice(0, 500)}`);
    const data = raw ? JSON.parse(raw) : {};
    const models = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
    if (!models.length) throw new Error('OmniRoute /models returned an empty catalog.');
    console.log(`[Mark 3] OmniRoute gateway online: ${models.length} catalog model(s) visible.`);
  } finally { clearTimeout(timer); }
}
async function probeManagedInference() {
  const before = await modelRouter.providerSnapshot();
  const configured = (before.providers || []).filter((row) => row.enabled && row.credentialDetected).map((row) => row.provider);
  const publicFallbacks = (before.providers || []).filter((row) => row.enabled && row.tier === 'public').map((row) => row.provider);
  console.log(`[Mark 3] Managed providers: configured=${configured.join(', ') || 'none'}; public fallback=${publicFallbacks.join(', ') || 'none'}; experimental=disabled.`);
  try {
    const result = await modelRouter.chat({
      messages: [
        { role: 'system', content: 'This is a startup health probe. Reply with a short acknowledgement.' },
        { role: 'user', content: 'Mark 3 readiness check.' },
      ],
      model: 'auto', taskType: 'simple_qa', tools: null,
    });
    console.log(`[Mark 3] Managed inference ready: provider=${result.provider}, model=${result.model}.`);
    return { ok: true, result };
  } catch (error) {
    const after = await modelRouter.providerSnapshot();
    const statuses = (after.providers || []).filter((row) => row.enabled).map((row) => `${row.provider}{credential=${row.credentialDetected},healthy=${row.healthyModel || 'no'},failure=${row.lastFailureKind || 'none'}}`).join(' ');
    console.error(`[Mark 3] Managed inference probe failed: ${error.message}`);
    if (statuses) console.error(`[Mark 3] Provider state: ${statuses}`);
    return { ok: false, error };
  }
}
async function stopLocalGatewayListener() {
  if (process.platform === 'win32') {
    const script = `$pids = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; foreach ($pidValue in $pids) { if ($pidValue -and $pidValue -ne $PID) { Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue } }`;
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000 });
  } else {
    try { await execFileAsync('sh', ['-lc', `pids=$(lsof -ti tcp:${port} 2>/dev/null || true); [ -z "$pids" ] || kill $pids`], { timeout: 15000 }); } catch {}
  }
  if (!(await waitForPortClosed())) throw new Error(`Could not stop the stale OmniRoute listener on port ${port}.`);
}
async function startLocalGateway() {
  const resolved = resolveEntry();
  if (!resolved) throw new Error('Local OmniRoute installation was not found. Set OMNIROUTE_DIR to the OmniRoute folder that contains package.json and scripts/dev/run-next.mjs.');
  fs.mkdirSync(logDir, { recursive: true });
  try { fs.writeFileSync(logFile, '', 'utf8'); } catch {}
  const handle = fs.openSync(logFile, 'a');
  const env = { ...process.env, PORT:String(port), HOST:host, OMNIROUTE_USE_TURBOPACK:'0', NEXT_TELEMETRY_DISABLED:'1' };
  const child = spawn(process.execPath, [`--max-old-space-size=${maxOldSpaceMb}`, resolved.entry, 'dev'], { cwd:resolved.cwd, env, windowsHide:process.platform === 'win32', detached:true, stdio:['ignore',handle,handle], shell:false });
  child.once('error', (error) => console.error(`[Mark 3] OmniRoute process error: ${error.message}`));
  child.unref(); try { fs.closeSync(handle); } catch {}
  console.log(`[Mark 3] Starting OmniRoute from ${resolved.cwd}`);
  if (!(await waitForPort())) {
    const tail = readTail(logFile);
    throw new Error(`OmniRoute did not become reachable on ${host}:${port}.${tail ? ` Last gateway output: ${tail}` : ` Check ${logFile}.`}`);
  }
}
async function main() {
  let reusedExisting = false;
  if (!isLoopback()) {
    console.log(`[Mark 3] Using configured remote OmniRoute endpoint ${baseUrl.origin}.`);
  } else if (await isPortOpen()) {
    reusedExisting = true;
    console.log(`[Mark 3] Existing OmniRoute gateway detected at http://${host}:${port}.`);
  } else {
    await startLocalGateway();
  }

  await verifyCatalog();
  let probe = await probeManagedInference();

  if (!probe.ok && isLoopback() && reusedExisting && restartStaleGateway) {
    console.log('[Mark 3] Existing OmniRoute is reachable but has no working managed provider. Restarting it once with the current .env...');
    await stopLocalGatewayListener();
    modelRouter.clearRoutingCache?.();
    await startLocalGateway();
    await verifyCatalog();
    probe = await probeManagedInference();
  }

  if (!probe.ok && requireReadyProvider) {
    throw new Error('OmniRoute gateway is running, but no managed provider completed a real inference. Check the provider state printed above.');
  }
}

main().catch((error) => {
  console.error(`[Mark 3] Startup blocked because inference is not ready: ${error.message}`);
  process.exit(1);
});
