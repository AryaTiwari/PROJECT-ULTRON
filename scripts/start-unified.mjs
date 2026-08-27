import process from 'node:process';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { load: loadCredentials } = require('../core/credentials/local-store');

const enabled = !/^(0|false|no|off)$/i.test(String(process.env.ULTRON_ENABLE_OPENCODE ?? '1'));
const openCodePort = Number(process.env.OPENCODE_PORT || 4096);
const openCodeHost = process.env.OPENCODE_HOST || '127.0.0.1';
const omniPort = Number(process.env.OMNIROUTE_PORT || 20128);
const omniHost = process.env.OMNIROUTE_HOST || '127.0.0.1';
const omniDir = process.env.OMNIROUTE_DIR || (process.platform === 'win32' && process.env.USERPROFILE
  ? path.join(process.env.USERPROFILE, 'Downloads', 'OmniRoute-release-v3.8.51', 'OmniRoute-release-v3.8.51')
  : '');
const configPath = path.resolve(process.env.ULTRON_OPENCODE_CONFIG || path.join(process.cwd(), '.ultron', 'opencode-omniroute.json'));
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

async function waitForPort(host, port, timeoutMs = 120000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await isPortOpen(host, port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function killChild(child) {
  if (child && !child.killed) {
    try { child.kill(); } catch {}
  }
}

function cleanup() {
  killChild(openCodeChild);
  killChild(omniChild);
}

function resolveOpenCodeCommand() {
  const candidates = [];
  const explicit = process.env.OPENCODE_BIN;
  if (explicit) candidates.push({ kind: process.platform === 'win32' && /\.(cmd|bat)$/i.test(explicit) ? 'cmd' : 'direct', command: explicit });

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
      if (fs.existsSync(candidate)) candidates.push({ kind: /\.(cmd|bat)$/i.test(candidate) ? 'cmd' : 'direct', command: candidate });
    }
    candidates.push({ kind: 'cmd', command: 'opencode.cmd' });
    candidates.push({ kind: 'cmd', command: 'opencode' });
    try {
      const result = spawnSync('where.exe', ['opencode.cmd'], { encoding: 'utf8', windowsHide: true });
      if (result.status === 0) {
        for (const line of String(result.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
          candidates.unshift({ kind: 'cmd', command: line });
        }
      }
    } catch {}
  } else {
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

function resolveOmniCommand() {
  if (!omniDir || !fs.existsSync(path.join(omniDir, 'package.json'))) return null;
  const runNext = path.join(omniDir, 'scripts', 'dev', 'run-next.mjs');
  if (!fs.existsSync(runNext)) return null;
  return { node: process.execPath, runNext };
}

async function configureOmniRoute() {
  const credentials = await loadCredentials();
  const apiKey = String(credentials.OMNIROUTE_API_KEY || process.env.OMNIROUTE_API_KEY || process.env.ULTRON_OMNIROUTE_API_KEY || '').trim();
  if (!apiKey) {
    console.warn('[OmniRoute] No local OmniRoute API key found; keeping OpenCode usable with its existing providers.');
    return { configured: false, apiKey: '' };
  }
  const response = await fetch(`http://${omniHost}:${omniPort}/v1/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
  const raw = await response.text();
  if (!response.ok) throw new Error(`OmniRoute model catalog HTTP ${response.status}: ${raw.slice(0, 800)}`);
  const data = raw ? JSON.parse(raw) : {};
  const models = Array.isArray(data?.data) ? data.data : [];
  if (!models.length) throw new Error('OmniRoute model catalog returned no models.');

  const modelMap = {};
  for (const model of models) {
    const id = String(model?.id || '').trim();
    if (!id) continue;
    modelMap[id] = { name: String(model?.name || id) };
    const context = Number(model?.context_length || model?.contextWindow || model?.context_length_tokens || 0);
    const output = Number(model?.max_output_tokens || model?.outputTokenLimit || 0);
    if (context || output) {
      modelMap[id].limit = {};
      if (context) modelMap[id].limit.context = context;
      if (output) modelMap[id].limit.output = output;
    }
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    provider: {
      omniroute: {
        npm: '@ai-sdk/openai-compatible',
        name: 'OmniRoute — ULTRON Fabric',
        options: { baseURL: `http://${omniHost}:${omniPort}/v1`, apiKey: '{env:OMNIROUTE_API_KEY}' },
        models: modelMap,
      },
    },
  }, null, 2), 'utf8');

  console.log(`[OmniRoute] OpenCode catalog configured: ${models.length} models.`);
  return { configured: true, apiKey };
}

async function ensureOmniRoute() {
  if (await isPortOpen(omniHost, omniPort)) {
    console.log(`[OmniRoute] Existing gateway detected at http://${omniHost}:${omniPort}.`);
    return;
  }
  const resolved = resolveOmniCommand();
  if (!resolved) {
    console.warn('[OmniRoute] Gateway not found locally; OpenCode will continue with its existing providers.');
    return;
  }
  console.log(`[OmniRoute] Starting gateway from ${omniDir}`);
  omniChild = spawn(resolved.node, ['--max-old-space-size=8192', resolved.runNext, 'dev'], {
    cwd: omniDir,
    stdio: 'inherit',
    detached: true,
    windowsHide: false,
  });
  omniChild.once('error', (error) => console.error(`[OmniRoute] Process error: ${error.message}`));
  omniChild.unref();
  if (await waitForPort(omniHost, omniPort)) console.log(`[OmniRoute] Gateway ready at http://${omniHost}:${omniPort}.`);
  else console.warn('[OmniRoute] Gateway did not become reachable; continuing with OpenCode existing providers.');
}

async function ensureOpenCode() {
  if (await isPortOpen(openCodeHost, openCodePort)) {
    console.log(`[OpenCode] Existing local server detected at http://${openCodeHost}:${openCodePort}.`);
    return;
  }

  const resolved = resolveOpenCodeCommand();
  if (!resolved) throw new Error('OpenCode executable could not be resolved.');

  let apiKey = '';
  try {
    const credentials = await loadCredentials();
    apiKey = String(credentials.OMNIROUTE_API_KEY || process.env.OMNIROUTE_API_KEY || process.env.ULTRON_OMNIROUTE_API_KEY || '').trim();
  } catch {}

  const env = { ...process.env, OPENCODE_CONFIG: configPath };
  if (apiKey) env.OMNIROUTE_API_KEY = apiKey;

  console.log(`[OpenCode] Starting local model server at http://${openCodeHost}:${openCodePort} using ${resolved.command}`);
  const args = ['serve', '--hostname', openCodeHost, '--port', String(openCodePort)];
  if (resolved.kind === 'cmd') openCodeChild = spawn('cmd.exe', ['/d', '/c', resolved.command, ...args], { env, stdio: 'inherit', detached: true, windowsHide: false, shell: false });
  else openCodeChild = spawn(resolved.command, args, { env, stdio: 'inherit', detached: true, windowsHide: false, shell: false });

  openCodeChild.once('error', (error) => console.error(`[OpenCode] Process error: ${error.message}`));
  openCodeChild.unref();
  if (!await waitForPort(openCodeHost, openCodePort)) throw new Error(`OpenCode local server did not become reachable at http://${openCodeHost}:${openCodePort}.`);
  console.log(`[OpenCode] Local server ready at http://${openCodeHost}:${openCodePort}.`);
}

async function main() {
  if (!enabled) {
    console.log('[OpenCode] Disabled for unified Mark 2 startup.');
    return;
  }
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);

  // OmniRoute is optional, but when available it becomes a live multi-model
  // provider inside OpenCode. Existing OpenCode providers (including Big Pickle)
  // remain intact.
  await ensureOmniRoute();
  try { await configureOmniRoute(); }
  catch (error) { console.warn(`[OmniRoute] Catalog configuration skipped: ${error.message}`); }
  await ensureOpenCode();
}

main().catch((error) => { console.error(`[Unified Start] ${error.message}`); process.exit(1); });
