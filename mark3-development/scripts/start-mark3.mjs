import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
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
const logFile = path.join(logDir, 'omniroute-production.log');
const readyTimeoutMs = Math.max(60000, Number(process.env.ULTRON_M3_OMNIROUTE_READY_TIMEOUT_MS || 240000));
const packageVersion = String(process.env.ULTRON_OMNIROUTE_PACKAGE_VERSION || '3.8.51').trim();
const memoryMb = Math.max(1024, Number(process.env.ULTRON_OMNIROUTE_MEMORY_MB || process.env.OMNIROUTE_MEMORY_MB || 2048));
const requireReadyProvider = !/^(0|false|no|off)$/i.test(String(process.env.ULTRON_M3_REQUIRE_READY_PROVIDER || '1'));
const allowSourceDev = /^(1|true|yes|on)$/i.test(String(process.env.ULTRON_M3_ALLOW_OMNIROUTE_SOURCE_DEV || '0'));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

async function waitForPortClosed(timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!(await isPortOpen())) return true;
    await sleep(300);
  }
  return false;
}

function readTail(file, lines = 100) {
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

async function fetchCatalogOnce(timeoutMs = 8000) {
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
      return await fetchCatalogOnce();
    } catch (error) {
      lastError = error;
      await sleep(1200);
    }
  }
  const detail = lastError?.name === 'AbortError'
    ? 'HTTP readiness checks kept timing out.'
    : lastError?.message || 'Unknown readiness failure.';
  throw new Error(`OmniRoute did not become HTTP-ready within ${Math.round(timeoutMs / 1000)}s. ${detail}`);
}

async function commandExists(command) {
  try {
    if (process.platform === 'win32') {
      await execFileAsync('where.exe', [command], { windowsHide: true, timeout: 5000 });
    } else {
      await execFileAsync('sh', ['-lc', `command -v ${command}`], { timeout: 5000 });
    }
    return true;
  } catch {
    return false;
  }
}

async function windowsListenerProcesses() {
  if (process.platform !== 'win32') return [];
  const script = [
    `$listenerPids = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`,
    '$rows = @()',
    'foreach ($listenerPid in $listenerPids) {',
    '  $p = Get-CimInstance Win32_Process -Filter "ProcessId = $listenerPid" -ErrorAction SilentlyContinue',
    '  if ($p) { $rows += [PSCustomObject]@{ pid = [int]$listenerPid; name = $p.Name; commandLine = $p.CommandLine } }',
    '}',
    '$rows | ConvertTo-Json -Compress',
  ].join('; ');
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    const text = String(stdout || '').trim();
    if (!text) return [];
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (error) {
    console.warn(`[Mark 3] Could not inspect OmniRoute listener process: ${error.message}`);
    return [];
  }
}

function isSourceDevProcess(info) {
  const commandLine = String(info?.commandLine || '').toLowerCase();
  return commandLine.includes('run-next.mjs') && /(?:^|\s)dev(?:\s|$)/.test(commandLine);
}

async function stopKnownSourceDevListeners(listeners) {
  const dev = (listeners || []).filter(isSourceDevProcess);
  if (!dev.length) return false;
  console.log(`[Mark 3] Detected OmniRoute source-development runtime on port ${port}. Migrating to the packaged production runtime to reduce memory pressure.`);
  for (const entry of dev) {
    try {
      await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Stop-Process -Id ${Number(entry.pid)} -Force -ErrorAction Stop`], {
        windowsHide: true,
        timeout: 10000,
      });
      console.log(`[Mark 3] Stopped OmniRoute dev listener PID ${entry.pid}.`);
    } catch (error) {
      throw new Error(`Could not stop the known OmniRoute dev listener PID ${entry.pid}: ${error.message}`);
    }
  }
  if (!(await waitForPortClosed())) throw new Error(`Port ${port} stayed open after stopping the OmniRoute dev runtime.`);
  return true;
}

function packagedLaunchSpec(useGlobal) {
  const cliArgs = `--no-open --no-tray --port ${port}`;
  if (process.platform === 'win32') {
    const shell = process.env.ComSpec || 'cmd.exe';
    const command = useGlobal
      ? `omniroute ${cliArgs}`
      : `npx --yes omniroute@${packageVersion} ${cliArgs}`;
    return { command: shell, args: ['/d', '/s', '/c', command], label: useGlobal ? 'global omniroute CLI' : `npx omniroute@${packageVersion}` };
  }
  return useGlobal
    ? { command: 'omniroute', args: ['--no-open', '--no-tray', '--port', String(port)], label: 'global omniroute CLI' }
    : { command: 'npx', args: ['--yes', `omniroute@${packageVersion}`, '--no-open', '--no-tray', '--port', String(port)], label: `npx omniroute@${packageVersion}` };
}

async function startPackagedGateway() {
  fs.mkdirSync(logDir, { recursive: true });
  const useGlobal = await commandExists(process.platform === 'win32' ? 'omniroute.cmd' : 'omniroute');
  const spec = packagedLaunchSpec(useGlobal);
  const handle = fs.openSync(logFile, 'a');
  const env = {
    ...process.env,
    PORT: String(port),
    OMNIROUTE_PORT: String(port),
    OMNIROUTE_MEMORY_MB: String(memoryMb),
    OMNIROUTE_NO_UPDATE_NOTIFIER: '1',
    OMNIROUTE_CLI_SKIP_REPO_ENV: '1',
    NEXT_TELEMETRY_DISABLED: '1',
  };

  const child = spawn(spec.command, spec.args, {
    cwd: projectRoot,
    env,
    windowsHide: true,
    detached: true,
    stdio: ['ignore', handle, handle],
    shell: false,
  });
  child.once('error', (error) => console.error(`[Mark 3] OmniRoute packaged-runtime process error: ${error.message}`));
  child.unref();
  try { fs.closeSync(handle); } catch {}

  console.log(`[Mark 3] Starting OmniRoute production runtime via ${spec.label} (heap cap ${memoryMb} MB).`);
  try {
    const count = await waitForHttpCatalog();
    console.log(`[Mark 3] OmniRoute production API ready: ${count} catalog model(s) visible.`);
  } catch (error) {
    const tail = readTail(logFile);
    throw new Error(`${error.message}${tail ? `\n[Mark 3] OmniRoute production log tail:\n${tail}` : ` Check ${logFile}.`}`);
  }
}

async function startSourceDevGateway() {
  if (!allowSourceDev) {
    throw new Error('Packaged OmniRoute could not be started. Source dev mode is disabled because it can exhaust memory on this machine. Set ULTRON_M3_ALLOW_OMNIROUTE_SOURCE_DEV=1 only for development diagnostics.');
  }
  throw new Error('Source OmniRoute dev fallback is intentionally not automatic in Mark 3. Use the packaged production runtime for normal ULTRON inference.');
}

async function verifyExistingGateway() {
  const count = await waitForHttpCatalog(Math.min(readyTimeoutMs, 45000));
  console.log(`[Mark 3] OmniRoute gateway online: ${count} catalog model(s) visible.`);
}

async function monitoringPressure() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${baseUrl.origin}/api/monitoring/health`, { signal: controller.signal });
    if (!response.ok) return null;
    const data = await response.json();
    const admission = data?.chatAdmission || data?.admission?.chatAdmission || null;
    return admission ? {
      severity: admission.pressureSeverity || admission.pressure?.severity || null,
      reason: admission.pressureReason || admission.pressure?.reason || null,
      inflightBytes: admission.inflightBytes ?? null,
      maxInflightBytes: admission.maxInflightBytes ?? null,
    } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function probeInference() {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
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
      lastError = error;
      const isPressure = error?.code === 'resource_pressure' || /resource[_ ]pressure|resource pressure/i.test(String(error?.message || ''));
      if (isPressure && attempt < 3) {
        const pressure = await monitoringPressure();
        console.warn(`[Mark 3] OmniRoute is still under resource pressure${pressure?.severity ? ` (${pressure.severity}${pressure.reason ? `/${pressure.reason}` : ''})` : ''}; waiting 5s before readiness retry ${attempt + 1}/3.`);
        await sleep(5000);
        continue;
      }
      break;
    }
  }

  console.error(`[Mark 3] OmniRoute inference probe failed: ${lastError?.message || 'unknown inference failure'}`);
  if (Array.isArray(lastError?.failures)) {
    for (const failure of lastError.failures.slice(-8)) {
      console.error(`[Mark 3]   ${failure.model} [${failure.provider}/${failure.kind}]: ${failure.message}`);
    }
  }
  const pressure = await monitoringPressure();
  if (pressure?.severity) {
    console.error(`[Mark 3] OmniRoute pressure snapshot: severity=${pressure.severity}${pressure.reason ? ` reason=${pressure.reason}` : ''}${pressure.inflightBytes != null ? ` inflightBytes=${pressure.inflightBytes}` : ''}${pressure.maxInflightBytes != null ? ` maxInflightBytes=${pressure.maxInflightBytes}` : ''}`);
  }
  return false;
}

async function ensureLocalGateway() {
  if (!isLoopback()) {
    console.log(`[Mark 3] Using configured remote OmniRoute endpoint ${baseUrl.origin}.`);
    await verifyExistingGateway();
    return;
  }

  if (await isPortOpen()) {
    const listeners = await windowsListenerProcesses();
    const migrated = await stopKnownSourceDevListeners(listeners);
    if (migrated) {
      await startPackagedGateway();
      return;
    }
    console.log(`[Mark 3] Existing OmniRoute gateway detected at http://${host}:${port}.`);
    await verifyExistingGateway();
    return;
  }

  try {
    await startPackagedGateway();
  } catch (error) {
    if (!allowSourceDev) throw error;
    await startSourceDevGateway();
  }
}

async function main() {
  await ensureLocalGateway();
  const ready = await probeInference();
  if (!ready && requireReadyProvider) {
    throw new Error('OmniRoute is online but no inference route completed the startup probe. The gateway has been left running for diagnostics.');
  }
}

main().catch((error) => {
  console.error(`[Mark 3] Startup blocked because inference is not ready: ${error.message}`);
  process.exit(1);
});
