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

async function waitForPort(host, port, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await isPortOpen(host, port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function waitForOpenCodeHealth(timeoutMs = 120000) {
  const started = Date.now();
  const url = `http://${openCodeHost}:${openCodePort}/global/health`;
  let lastError = '';
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      const raw = await response.text();
      if (response.ok) {
        let data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch {}
        if (data?.healthy !== false) return data;
        lastError = `HTTP ${response.status}: ${raw.slice(0, 800)}`;
      } else lastError = `HTTP ${response.status}: ${raw.slice(0, 800)}`;
    } catch (error) { lastError = error?.cause?.message || error?.message || String(error); }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  throw new Error(`OpenCode health check failed at ${url}: ${lastError || 'server unavailable'}. Check ${openCodeLog}.`);
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
  if (!fs.existsSync(path.join(omniDir, 'scripts', 'dev', 'run-next.mjs'))) return null;
  return { cwd: omniDir };
}

async function configureOmniRoute() {
  const credentials = await loadCredentials();
  const apiKey = String(credentials.OMNIROUTE_API_KEY || process.env.OMNIROUTE_API_KEY || process.env.ULTRON_OMNIROUTE_API_KEY || '').trim();
  if (!apiKey) return { configured: false, apiKey: '' };
  const response = await fetch(`http://${omniHost}:${omniPort}/v1/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
  const raw = await response.text(); if (!response.ok) throw new Error(`OmniRoute model catalog HTTP ${response.status}: ${raw.slice(0, 800)}`);
  const data = raw ? JSON.parse(raw) : {}; const models = Array.isArray(data?.data) ? data.data : []; if (!models.length) throw new Error('OmniRoute model catalog returned no models.');
  const modelMap = {};
  for (const model of models) { const id = String(model?.id || '').trim(); if (!id) continue; const entry = { name: String(model?.name || id) }; const context = Number(model?.context_length || model?.contextWindow || model?.context_length_tokens || 0); const output = Number(model?.max_output_tokens || model?.outputTokenLimit || 0); if (context || output) { entry.limit = {}; if (context) entry.limit.context = context; if (output) entry.limit.output = output; } modelMap[id] = entry; }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ $schema: 'https://opencode.ai/config.json', provider: { omniroute: { npm: '@ai-sdk/openai-compatible', name: 'OmniRoute — ULTRON Fabric', options: { baseURL: `http://${omniHost}:${omniPort}/v1`, apiKey: '{env:OMNIROUTE_API_KEY}' }, models: modelMap } } }, null, 2), 'utf8');
  console.log(`[OmniRoute] OpenCode catalog configured: ${models.length} models.`); return { configured: true, apiKey };
}

async function ensureOmniRoute() {
  if (await isPortOpen(omniHost, omniPort)) {
    console.log(`[OmniRoute] Existing gateway detected at http://${omniHost}:${omniPort}.`);
    return;
  }
  const resolved = resolveOmniCommand();
  if (!resolved) {
    console.warn('[OmniRoute] Gateway not found locally; continuing without local gateway startup.');
    return;
  }
  console.log(`[OmniRoute] Starting gateway from ${resolved.cwd}`);
  fs.mkdirSync(logDir, { recursive: true });
  try { fs.writeFileSync(omniLog, '', 'utf8'); } catch {}

  if (process.platform === 'win32') {
    const childEnv = {
      ...process.env,
      PORT: String(omniPort),
      HOST: omniHost,
      OMNIROUTE_USE_TURBOPACK: '0',
    };
    omniChild = spawn('cmd.exe', ['/d', '/c', `set "PORT=${childEnv.PORT}"&& set "HOST=${childEnv.HOST}"&& set "OMNIROUTE_USE_TURBOPACK=0"&& npm.cmd run dev > "${omniLog}" 2>&1`], {
      cwd: resolved.cwd,
      env: childEnv,
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
      shell: false,
    });
  } else {
    omniChild = spawn('npm', ['run', 'dev'], {
      cwd: resolved.cwd,
      env: { ...process.env, PORT: String(omniPort), HOST: omniHost },
      stdio: 'ignore',
      detached: true,
      shell: false,
    });
  }

  omniChild.once('error', (error) => console.error(`[OmniRoute] Process error: ${error.message}`));
  omniChild.unref();

  if (await waitForPort(omniHost, omniPort, 30000)) {
    console.log(`[OmniRoute] Gateway ready at http://${omniHost}:${omniPort}.`);
    return;
  }

  let tail = '';
  try {
    const raw = fs.readFileSync(omniLog, 'utf8');
    tail = raw.slice(-4000);
  } catch {}
  throw new Error(`[OmniRoute] Gateway did not become reachable at http://${omniHost}:${omniPort}. Check ${omniLog}.${tail ? `\nLast OmniRoute log output:\n${tail}` : ''}`);
}

async function ensureOpenCode() {
  if (await isPortOpen(openCodeHost, openCodePort)) { console.log(`[OpenCode] Existing local server detected at http://${openCodeHost}:${openCodePort}.`); await waitForOpenCodeHealth(); return; }
  const resolved = resolveOpenCodeCommand(); if (!resolved) throw new Error('OpenCode executable could not be resolved.');
  let apiKey = ''; try { const credentials = await loadCredentials(); apiKey = String(credentials.OMNIROUTE_API_KEY || process.env.OMNIROUTE_API_KEY || process.env.ULTRON_OMNIROUTE_API_KEY || '').trim(); } catch {}
  fs.mkdirSync(logDir, { recursive: true }); try { fs.writeFileSync(openCodeLog, '', 'utf8'); } catch {}
  const env = { ...process.env, OPENCODE_CONFIG: configPath }; if (apiKey) env.OMNIROUTE_API_KEY = apiKey;
  console.log(`[OpenCode] Starting local model server at http://${openCodeHost}:${openCodePort} using ${resolved.command}`); const args = ['serve', '--hostname', openCodeHost, '--port', String(openCodePort)];
  if (process.platform === 'win32') { const encodedEnv = Buffer.from(JSON.stringify({ OPENCODE_CONFIG: configPath, OMNIROUTE_API_KEY: apiKey })).toString('base64'); const full = `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedEnv}')) | ConvertFrom-Json | ForEach-Object { if ($_.OPENCODE_CONFIG) { $env:OPENCODE_CONFIG=$_.OPENCODE_CONFIG }; if ($_.OMNIROUTE_API_KEY) { $env:OMNIROUTE_API_KEY=$_.OMNIROUTE_API_KEY } }; $ErrorActionPreference='Continue'; & cmd.exe /d /c '${String(resolved.command).replace(/'/g, "''")}' ${args.join(' ')} *> '${openCodeLog.replace(/'/g, "''")}'`; const outer = `Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',${JSON.stringify(full)} -WorkingDirectory '${process.cwd().replace(/'/g, "''")}'`; openCodeChild = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', outer], { stdio: 'ignore', windowsHide: true, shell: false }); }
  else openCodeChild = spawn(resolved.command, args, { env, stdio: 'ignore', detached: true, shell: false });
  openCodeChild.once('error', (error) => console.error(`[OpenCode] Process error: ${error.message}`)); openCodeChild.unref(); await waitForOpenCodeHealth(); console.log(`[OpenCode] Local server healthy at http://${openCodeHost}:${openCodePort}.`);
}

async function main() {
  process.once('SIGINT', cleanup); process.once('SIGTERM', cleanup); await ensureOmniRoute();
  if (openCodeEnabled) { try { await configureOmniRoute(); } catch (error) { console.warn(`[OmniRoute] OpenCode catalog configuration skipped: ${error.message}`); } await ensureOpenCode(); }
  else console.log('[OpenCode] Skipped; OmniRoute is the primary Mark 2 transport. Set ULTRON_ENABLE_OPENCODE=1 to enable the optional OpenCode server.');
}
main().catch((error) => { console.error(`[Unified Start] ${error.message}`); process.exit(1); });
