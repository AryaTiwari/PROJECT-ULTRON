const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { config } = require('../config');
const voiceConfig = require('../voice/config').config;

const execFileAsync = promisify(execFile);

function result(name, status, extra = {}) {
  return { name, status, ...extra, checkedAt: new Date().toISOString() };
}

async function checkHttp(url, timeoutMs = 5000, headers = {}) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    return { ok: response.ok, statusCode: response.status, latencyMs: Date.now() - started };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, error: error?.message || String(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function checkGithub() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const target = process.env.GITHUB_STATUS_URL || 'https://api.github.com/rate_limit';
  const probe = await checkHttp(target, 7000, headers);
  return result('github', probe.ok ? (token ? 'CONNECTED' : 'REACHABLE_UNAUTHENTICATED') : 'OFFLINE', {
    configured: Boolean(token),
    authenticated: Boolean(token && probe.ok),
    latencyMs: probe.latencyMs,
    httpStatus: probe.statusCode,
    error: probe.error,
  });
}

async function checkInstagram() {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN || process.env.IG_ACCESS_TOKEN || '';
  const userId = process.env.INSTAGRAM_USER_ID || process.env.IG_USER_ID || '';
  if (!token) return result('instagram', 'NOT_CONFIGURED', { configured: false, authenticated: false });
  const base = process.env.INSTAGRAM_GRAPH_URL || 'https://graph.instagram.com';
  const target = userId ? `${base}/${encodeURIComponent(userId)}?fields=id,username&access_token=${encodeURIComponent(token)}` : `${base}/me?fields=id,username&access_token=${encodeURIComponent(token)}`;
  const probe = await checkHttp(target, 7000);
  return result('instagram', probe.ok ? 'CONNECTED' : 'AUTH_OR_NETWORK_ERROR', {
    configured: true,
    authenticated: probe.ok,
    userIdConfigured: Boolean(userId),
    latencyMs: probe.latencyMs,
    httpStatus: probe.statusCode,
    error: probe.error,
  });
}

async function checkAdministrator() {
  if (process.platform !== 'win32') return result('administrator', process.getuid?.() === 0 ? 'ELEVATED' : 'STANDARD', { elevated: process.getuid?.() === 0, platform: process.platform });
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'], { windowsHide: true, timeout: 5000 });
    const elevated = /^true\s*$/i.test(String(stdout).trim());
    return result('administrator', elevated ? 'ELEVATED' : 'STANDARD', { elevated, platform: process.platform, account: os.userInfo().username });
  } catch (error) {
    return result('administrator', 'UNKNOWN', { elevated: false, platform: process.platform, error: error?.message || String(error) });
  }
}

async function checkOmniRoute() {
  const base = String(process.env.OMNIROUTE_BASE_URL || 'http://127.0.0.1:20128').replace(/\/$/, '');
  const target = process.env.OMNIROUTE_STATUS_URL || `${base}/health`;
  const probe = await checkHttp(target, 4000);
  return result('omniroute', probe.ok || probe.statusCode === 401 ? (probe.statusCode === 401 ? 'ONLINE_AUTH_REQUIRED' : 'ONLINE') : 'OFFLINE', {
    configured: true,
    endpoint: base,
    latencyMs: probe.latencyMs,
    httpStatus: probe.statusCode,
    error: probe.error,
  });
}

async function checkMemory() {
  try {
    const memory = require('../memory/manager');
    const status = typeof memory.status === 'function' ? await memory.status() : null;
    return result('memory', status?.ready === false ? 'DEGRADED' : 'READY', { backend: status?.backend || 'local', details: status || undefined });
  } catch (error) {
    return result('memory', 'UNKNOWN', { error: error?.message || String(error) });
  }
}

async function checkInternetSpeed() {
  const url = process.env.INTERNET_SPEED_TEST_URL || 'https://speed.cloudflare.com/__down?bytes=1000000';
  const controller = new AbortController();
  const started = Date.now();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok || !response.body) return result('internet_speed', 'ERROR', { httpStatus: response.status });
    let bytes = 0;
    for await (const chunk of response.body) bytes += Buffer.byteLength(chunk);
    const elapsedSeconds = Math.max((Date.now() - started) / 1000, 0.001);
    const mbps = (bytes * 8) / elapsedSeconds / 1_000_000;
    return result('internet_speed', 'CONNECTED', { latencyMs: Date.now() - started, measuredMbps: Number(mbps.toFixed(2)), bytes });
  } catch (error) {
    return result('internet_speed', 'OFFLINE_OR_BLOCKED', { error: error?.message || String(error) });
  } finally {
    clearTimeout(timer);
  }
}

async function checkMood() {
  try {
    const moodPath = require('path').resolve(process.env.ULTRON_MOOD_FILE || '.ultron/mood.json');
    const fs = require('fs');
    if (!fs.existsSync(moodPath)) return result('mood', 'CALM', { source: 'default' });
    const data = JSON.parse(fs.readFileSync(moodPath, 'utf8'));
    return result('mood', String(data.mood || 'CALM').toUpperCase(), { intensity: Number(data.intensity || 0), source: 'runtime' });
  } catch {
    return result('mood', 'CALM', { source: 'fallback' });
  }
}

async function collectSystemStatus() {
  const [mood, github, instagram, administrator, omniroute, internetSpeed, memory] = await Promise.all([
    checkMood(), checkGithub(), checkInstagram(), checkAdministrator(), checkOmniRoute(), checkInternetSpeed(), checkMemory(),
  ]);

  return {
    ok: true,
    service: 'ultron-status',
    version: 'mark2',
    timestamp: new Date().toISOString(),
    status: { mood, github, instagram, administrator, omniroute, internetSpeed, memory },
    voice: { provider: voiceConfig.provider, model: voiceConfig.model, referenceId: voiceConfig.referenceId, metallicMix: voiceConfig.metallicMix },
  };
}

module.exports = { collectSystemStatus, checkGithub, checkInstagram, checkAdministrator, checkOmniRoute, checkInternetSpeed, checkMemory, checkMood };
