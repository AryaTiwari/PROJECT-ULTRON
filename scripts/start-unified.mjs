import process from 'node:process';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { load: loadCredentials } = require('../core/credentials/local-store');

const omniHost = process.env.OMNIROUTE_HOST || '127.0.0.1';
const omniPort = Number(process.env.OMNIROUTE_PORT || 20128);
const openCodeHost = process.env.OPENCODE_HOST || '127.0.0.1';
const openCodePort = Number(process.env.OPENCODE_PORT || 4096);
const cwd = process.cwd();
let omniChild = null;
let openCodeChild = null;

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
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

function terminate(child) {
  if (child && !child.killed) { try { child.kill(); } catch {} }
}

function resolveOpenCodeCommand() {
  const candidates = [];
  const explicit = process.env.OPENCODE_BIN;
  if (explicit) candidates.push({ kind: /\.(cmd|bat)$/i.test(explicit) ? 'cmd' : 'direct', command: explicit });
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || '';
    const localAppData = process.env.LOCALAPPDATA || '';
    const userProfile = process.env.USERPROFILE || process.env.HOME || '';
    const paths = [
      path.join(appData, 'npm', 'opencode.cmd'),
      path.join(appData, 'npm', 'opencode.CMD'),
      path.join(appData, 'npm', 'opencode.exe'),
      path.join(localAppData, 'Programs', 'opencode', 'opencode.exe'),
      path.join(userProfile, '.opencode', 'bin', 'opencode.exe'),
    ];
    for (const candidate of paths) if (fs.existsSync(candidate)) candidates.push({ kind: /\.(cmd|bat)$/i.test(candidate) ? 'cmd' : 'direct', command: candidate });
    try {
      const result = spawnSync('where.exe', ['opencode.cmd'], { encoding: 'utf8', windowsHide: true });
      if (result.status === 0) for (const line of String(result.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)) candidates.unshift({ kind: 'cmd', command: line });
    } catch {}
    candidates.push({ kind: 'cmd', command: 'opencode.cmd' });
  } else candidates.push({ kind: 'direct', command: 'opencode' });
  const seen = new Set();
  return candidates.find((c) => { const key = `${c.kind}:${c.command}`; if (seen.has(key)) return false; seen.add(key); return true; }) || null;
}

function omniRouteDir() {
  return process.env.OMNIROUTE_DIR || (process.platform === 'win32' && process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, 'Downloads', 'OmniRoute-release-v3.8.51', 'OmniRoute-release-v3.8.51') : '');
}

async function startOmniRoute() {
  const credentials = await loadCredentials();
  const apiKey = String(credentials.OMNIROUTE_API_KEY || process.env.OMNIROUTE_API_KEY || process.env.ULTRON_OMNIROUTE_API_KEY || '').trim();
  if (!apiKey) {
    console.log('[OmniRoute] No local OmniRoute credential found; skipping catalog gateway.');
    return { apiKey: '', started: false };
  }
  if (await isPortOpen(omniHost, omniPort)) {
    console.log(`[OmniRoute] Existing gateway detected at http://${omniHost}:${omniPort}.`);
    return { apiKey, started: false };
  }
  const dir = omniRouteDir();
  const runNext = path.join(dir, 'scripts', 'dev', 'run-next.mjs');
  if (!dir || !fs.existsSync(path.join(dir, 'package.json')) || !fs.existsSync(runNext)) throw new Error(`OmniRoute is not running and its installation could not be found at ${dir || '<unset>'}.`);
  console.log(`[OmniRoute] Starting catalog gateway from ${dir}`);
  omniChild = spawn(process.execPath, ['--max-old-space-size=8192', runNext, 'dev'], { cwd: dir, stdio: 'ignore', detached: true, windowsHide: true, env: { ...process.env, OMNIROUTE_API_KEY: apiKey } });
  omniChild.once('error', (e) => console.error(`[OmniRoute] Process error: ${e.message}`));
  omniChild.unref();
  if (!await waitForPort(omniHost, omniPort)) throw new Error(`OmniRoute did not become reachable at http://${omniHost}:${omniPort}.`);
  console.log(`[OmniRoute] Gateway ready at http://${omniHost}:${omniPort}.`);
  return { apiKey, started: true };
}

async function refreshOpenCodeCatalog(apiKey) {
  if (!apiKey) return null;
  const configPath = path.resolve(process.env.ULTRON_OPENCODE_CONFIG || path.join(cwd, '.ultron', 'opencode.json'));
  const response = await fetch(`http://${omniHost}:${omniPort}/v1/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
  const raw = await response.text();
  if (!response.ok) throw new Error(`OmniRoute model catalog HTTP ${response.status}: ${raw.slice(0, 600)}`);
  const data = raw ? JSON.parse(raw) : {};
  const models = Array.isArray(data?.data) ? data.data : [];
  if (!models.length) throw new Error('OmniRoute model catalog returned no models.');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  let existing = {};
  if (fs.existsSync(configPath)) {
    try { existing = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { existing = {}; }
  }
  const modelMap = { ...(existing.provider?.omniroute?.models || {}) };
  for (const model of models) {
    const id = String(model?.id || '').trim();
    if (id) modelMap[id] = { ...(modelMap[id] || {}), name: String(model?.name || id) };
  }
  const merged = { ...existing, $schema: 'https://opencode.ai/config.json', provider: { ...(existing.provider || {}), omniroute: { ...(existing.provider?.omniroute || {}), npm: '@ai-sdk/openai-compatible', name: 'OmniRoute — ULTRON Fabric', options: { ...(existing.provider?.omniroute?.options || {}), baseURL: `http://${omniHost}:${omniPort}/v1`, apiKey: '{env:OMNIROUTE_API_KEY}' }, models: modelMap } } };
  const temp = `${configPath}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(merged, null, 2), 'utf8');
  fs.renameSync(temp, configPath);
  console.log(`[OmniRoute] OpenCode catalog configured: ${models.length} models.`);
  return configPath;
}

async function startOpenCode(omniApiKey, configPath) {
  if (await isPortOpen(openCodeHost, openCodePort)) {
    console.log(`[OpenCode] Existing local server detected at http://${openCodeHost}:${openCodePort}.`);
    return;
  }
  const resolved = resolveOpenCodeCommand();
  if (!resolved) throw new Error('OpenCode executable could not be resolved.');
  const args = ['serve', '--hostname', openCodeHost, '--port', String(openCodePort)];
  const env = { ...process.env };
  if (omniApiKey) env.OMNIROUTE_API_KEY = omniApiKey;
  if (configPath) env.OPENCODE_CONFIG = configPath;
  console.log(`[OpenCode] Starting local model server at http://${openCodeHost}:${openCodePort} using ${resolved.command}`);
  openCodeChild = resolved.kind === 'cmd'
    ? spawn('cmd.exe', ['/d', '/c', resolved.command, ...args], { stdio: 'ignore', detached: true, windowsHide: true, shell: false, env })
    : spawn(resolved.command, args, { stdio: 'ignore', detached: true, windowsHide: true, shell: false, env });
  openCodeChild.once('error', (e) => console.error(`[OpenCode] Process error: ${e.message}`));
  openCodeChild.unref();
  if (!await waitForPort(openCodeHost, openCodePort, 60000)) throw new Error(`OpenCode did not become reachable at http://${openCodeHost}:${openCodePort}.`);
  console.log(`[OpenCode] Local server ready at http://${openCodeHost}:${openCodePort}.`);
}

async function main() {
  const enabled = !/^(0|false|no|off)$/i.test(String(process.env.ULTRON_ENABLE_OPENCODE ?? '1'));
  if (!enabled) return;
  try {
    const { apiKey } = await startOmniRoute();
    const configPath = await refreshOpenCodeCatalog(apiKey);
    await startOpenCode(apiKey, configPath);
  } catch (error) {
    console.error(`[Unified Start] ${error.message}`);
    process.exit(1);
  }
}

process.once('SIGINT', () => { terminate(omniChild); terminate(openCodeChild); });
process.once('SIGTERM', () => { terminate(omniChild); terminate(openCodeChild); });
main();
