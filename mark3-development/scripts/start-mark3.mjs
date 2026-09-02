import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const mark3Dir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const projectRoot = path.resolve(mark3Dir, '..');
const require = createRequire(import.meta.url);
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
const readyTimeoutMs = Math.max(30000, Number(process.env.ULTRON_M3_OMNIROUTE_READY_TIMEOUT_MS || 120000));
const maxOldSpaceMb = Math.max(1024, Number(process.env.ULTRON_OMNIROUTE_MAX_OLD_SPACE_MB || 3072));
const requireReadyProvider = !/^(0|false|no|off)$/i.test(String(process.env.ULTRON_M3_REQUIRE_READY_PROVIDER || '1'));

function isLoopback() {
  const value = String(host).toLowerCase();
  return value === '127.0.0.1' || value === 'localhost' || value === '::1' || value === '[::1]';
}

function isPortOpen() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      resolve(value);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(800, () => done(false));
  });
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
  const firstLevel = fs.readdirSync(downloads, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /omniroute/i.test(entry.name))
    .map((entry) => path.join(downloads, entry.name));
  for (const folder of firstLevel) {
    hits.push(folder);
    try {
      for (const nested of fs.readdirSync(folder, { withFileTypes: true })) {
        if (nested.isDirectory()) hits.push(path.join(folder, nested.name));
      }
    } catch {}
  }
  return hits;
}

function resolveEntry() {
  const candidates = [
    process.env.OMNIROUTE_DIR,
    path.join(os.homedir(), 'Downloads', 'OmniRoute-release-v3.8.51', 'OmniRoute-release-v3.8.51'),
    ...scanDownloads(),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const resolved = validOmniDir(candidate);
    if (resolved) return resolved;
  }
  return null;
}

function readTail(file, lines = 80) {
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

async function fetchCatalogOnce(timeoutMs = 6000) {
  const key = await resolveEndpointKey();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = key ? { Authorization: `Bearer ${key}` } : {};
    const response = await fetch(`${baseUrl.toString().replace(/\/$/, '')}/models`, { headers, signal: controller.signal });
    const raw = await response.text();
    if (!response.ok) throw new Error(`OmniRoute /models HTTP ${response.status}: ${raw.slice(0, 500)}`);
    const data = raw ? JSON.parse(raw) : {};
    const models = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
    if (!models.length) throw new Error('OmniRoute /models returned an empty catalog.');
    return models.length;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHttpCatalog(timeoutMs = readyTimeoutMs) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const count = await fetchCatalogOnce(6000);
      return count;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  const detail = lastError?.name === 'AbortError' ? 'HTTP readiness checks kept timing out.' : lastError?.message || 'Unknown readiness failure.';
  throw new Error(`OmniRoute did not become HTTP-ready within ${Math.round(timeoutMs / 1000)}s. ${detail}`);
}

async function startLocalGateway() {
  const resolved = resolveEntry();
  if (!resolved) {
    throw new Error('Local OmniRoute installation was not found. Set OMNIROUTE_DIR to the OmniRoute folder that contains package.json and scripts/dev/run-next.mjs.');
  }

  fs.mkdirSync(logDir, { recursive: true });
  const handle = fs.openSync(logFile, 'a');
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: host,
    OMNIROUTE_USE_TURBOPACK: '0',
    NEXT_TELEMETRY_DISABLED: '1',
  };

  const child = spawn(process.execPath, [`--max-old-space-size=${maxOldSpaceMb}`, resolved.entry, 'dev'], {
    cwd: resolved.cwd,
    env,
    windowsHide: process.platform === 'win32',
    detached: true,
    stdio: ['ignore', handle, handle],
    shell: false,
  });
  child.once('error', (error) => console.error(`[Mark 3] OmniRoute process error: ${error.message}`));
  child.unref();
  try { fs.closeSync(handle); } catch {}
  console.log(`[Mark 3] Starting OmniRoute from ${resolved.cwd}`);

  try {
    const count = await waitForHttpCatalog();
    console.log(`[Mark 3] OmniRoute HTTP API ready: ${count} catalog model(s) visible.`);
  } catch (error) {
    const tail = readTail(logFile);
    throw new Error(`${error.message}${tail ? `\n[Mark 3] OmniRoute log tail:\n${tail}` : ` Check ${logFile}.`}`);
  }
}

async function verifyExistingGateway() {
  const count = await waitForHttpCatalog(Math.min(readyTimeoutMs, 30000));
  console.log(`[Mark 3] OmniRoute gateway online: ${count} catalog model(s) visible.`);
}

async function probeInference() {
  try {
    const result = await modelRouter.chat({
      messages: [
        { role: 'system', content: 'This is an ULTRON startup health probe. Reply briefly.' },
        { role: 'user', content: 'Mark 3 readiness check.' },
      ],
      model: 'auto',
      taskType: 'simple_qa',
      tools: null,
    });
    console.log(`[Mark 3] OmniRoute inference ready: mode=${result.routingMode || 'omniroute'}, provider=${result.provider}, model=${result.model}.`);
    return true;
  } catch (error) {
    console.error(`[Mark 3] OmniRoute inference probe failed: ${error.message}`);
    if (Array.isArray(error?.failures)) {
      for (const failure of error.failures.slice(-8)) {
        console.error(`[Mark 3]   ${failure.model} [${failure.provider}/${failure.kind}]: ${failure.message}`);
      }
    }
    return false;
  }
}

async function main() {
  if (!isLoopback()) {
    console.log(`[Mark 3] Using configured remote OmniRoute endpoint ${baseUrl.origin}.`);
    await verifyExistingGateway();
  } else if (await isPortOpen()) {
    console.log(`[Mark 3] Existing OmniRoute gateway detected at http://${host}:${port}.`);
    await verifyExistingGateway();
  } else {
    // Non-destructive recovery: if the gateway is absent, start it. Mark 3 never
    // kills a reachable OmniRoute process automatically.
    await startLocalGateway();
  }

  const ready = await probeInference();
  if (!ready && requireReadyProvider) {
    throw new Error('OmniRoute is online but no inference route completed the startup probe. The gateway has been left running for diagnostics.');
  }
}

main().catch((error) => {
  console.error(`[Mark 3] Startup blocked because inference is not ready: ${error.message}`);
  process.exit(1);
});
