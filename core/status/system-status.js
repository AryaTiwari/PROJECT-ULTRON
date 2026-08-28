const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const voiceConfig = require('../voice/config').config;
const credentialStore = require('../credentials/local-store');
const omniRoute = require('../omniroute');

const execFileAsync = promisify(execFile);

function result(name, status, extra = {}) { return { name, status, ...extra, checkedAt: new Date().toISOString() }; }
async function credentials() { try { return await credentialStore.load(); } catch { return {}; } }
async function checkHttp(url, timeoutMs = 5000, headers = {}) {
  const started = Date.now(); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { const response = await fetch(url, { method: 'GET', headers, signal: controller.signal }); return { ok: response.ok, statusCode: response.status, latencyMs: Date.now() - started }; }
  catch (error) { return { ok: false, latencyMs: Date.now() - started, error: error?.message || String(error) }; }
  finally { clearTimeout(timer); }
}
async function checkGithub() {
  const saved = await credentials(); const token = saved.GITHUB_TOKEN || saved.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }; if (token) headers.Authorization = `Bearer ${token}`;
  const probe = await checkHttp(process.env.GITHUB_STATUS_URL || 'https://api.github.com/rate_limit', 7000, headers);
  return result('github', probe.ok ? (token ? 'CONNECTED' : 'REACHABLE_UNAUTHENTICATED') : 'OFFLINE', { configured: Boolean(token), authenticated: Boolean(token && probe.ok), credentialSource: saved.GITHUB_TOKEN || saved.GH_TOKEN ? 'local-dpapi' : token ? 'environment' : 'none', latencyMs: probe.latencyMs, httpStatus: probe.statusCode, error: probe.error });
}
async function checkInstagram() {
  const saved = await credentials(); const token = saved.INSTAGRAM_ACCESS_TOKEN || saved.IG_ACCESS_TOKEN || process.env.INSTAGRAM_ACCESS_TOKEN || process.env.IG_ACCESS_TOKEN || ''; const userId = saved.INSTAGRAM_USER_ID || saved.IG_USER_ID || process.env.INSTAGRAM_USER_ID || process.env.IG_USER_ID || '';
  if (!token) return result('instagram', 'NOT_CONFIGURED', { configured: false, authenticated: false });
  const base = process.env.INSTAGRAM_GRAPH_URL || 'https://graph.instagram.com'; const target = userId ? `${base}/${encodeURIComponent(userId)}?fields=id,username&access_token=${encodeURIComponent(token)}` : `${base}/me?fields=id,username&access_token=${encodeURIComponent(token)}`;
  const probe = await checkHttp(target, 7000);
  return result('instagram', probe.ok ? 'CONNECTED' : 'AUTH_OR_NETWORK_ERROR', { configured: true, authenticated: probe.ok, userIdConfigured: Boolean(userId), credentialSource: saved.INSTAGRAM_ACCESS_TOKEN || saved.IG_ACCESS_TOKEN ? 'local-dpapi' : 'environment', latencyMs: probe.latencyMs, httpStatus: probe.statusCode, error: probe.error });
}
async function checkAdministrator() {
  if (process.platform !== 'win32') return result('administrator', process.getuid?.() === 0 ? 'ELEVATED' : 'STANDARD', { elevated: process.getuid?.() === 0, platform: process.platform });
  try { const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'], { windowsHide: true, timeout: 5000 }); const elevated = /^true\s*$/i.test(String(stdout).trim()); return result('administrator', elevated ? 'ELEVATED' : 'STANDARD', { elevated, platform: process.platform, account: os.userInfo().username }); }
  catch (error) { return result('administrator', 'UNKNOWN', { elevated: false, platform: process.platform, error: error?.message || String(error) }); }
}
async function checkOmniRoute() {
  const health = await omniRoute.health();
  return result('omniroute', health.ok ? 'ONLINE' : 'OFFLINE', {
    configured: health.authenticated,
    endpoint: health.endpoint,
    authenticated: health.authenticated,
    modelCount: health.modelCount,
    catalogSample: health.catalogSample,
    latencyMs: health.latencyMs,
    httpStatus: health.status,
    error: health.error,
  });
}
async function checkMemory() {
  const dataDir = path.resolve(process.env.ULTRON_DATA_DIR || '.ultron'); const memoryDir = path.join(dataDir, 'memory'); const saved = await credentials(); const supabaseConfigured = Boolean((saved.SUPABASE_URL || process.env.SUPABASE_URL) && (saved.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || saved.SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY));
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch {}
  let writable = false; try { const p = path.join(dataDir, '.write-test'); fs.writeFileSync(p, 'ok'); fs.rmSync(p, { force: true }); writable = true; } catch {}
  return result('memory', supabaseConfigured ? 'LOCAL_READY_SUPABASE_CONFIGURED' : 'LOCAL_READY', { localPath: dataDir, memoryDirectory: memoryDir, supabaseConfigured, writable });
}
async function checkInternetSpeed() {
  const url = process.env.INTERNET_SPEED_TEST_URL || 'https://speed.cloudflare.com/__down?bytes=1000000'; const controller = new AbortController(); const started = Date.now(); const timer = setTimeout(() => controller.abort(), 10000);
  try { const response = await fetch(url, { signal: controller.signal, cache: 'no-store' }); if (!response.ok || !response.body) return result('internet_speed', 'ERROR', { httpStatus: response.status }); let bytes = 0; for await (const chunk of response.body) bytes += Buffer.byteLength(chunk); const elapsedSeconds = Math.max((Date.now() - started) / 1000, 0.001); return result('internet_speed', 'CONNECTED', { latencyMs: Date.now() - started, measuredMbps: Number(((bytes * 8) / elapsedSeconds / 1000000).toFixed(2)), bytes }); }
  catch (error) { return result('internet_speed', 'OFFLINE_OR_BLOCKED', { error: error?.message || String(error) }); } finally { clearTimeout(timer); }
}
async function checkMood() {
  try { const moodPath = path.resolve(process.env.ULTRON_MOOD_FILE || '.ultron/mood.json'); if (!fs.existsSync(moodPath)) return result('mood', 'CALM', { source: 'default' }); const data = JSON.parse(fs.readFileSync(moodPath, 'utf8')); return result('mood', String(data.mood || 'CALM').toUpperCase(), { intensity: Number(data.intensity || 0), source: 'runtime' }); } catch { return result('mood', 'CALM', { source: 'fallback' }); }
}
async function collectSystemStatus() {
  const [mood, github, instagram, administrator, omniroute, internetSpeed, memory] = await Promise.all([checkMood(), checkGithub(), checkInstagram(), checkAdministrator(), checkOmniRoute(), checkInternetSpeed(), checkMemory()]);
  return { ok: true, service: 'ultron-status', version: 'mark2', timestamp: new Date().toISOString(), status: { mood, github, instagram, administrator, omniroute, internetSpeed, memory }, credentials: await credentialStore.status(), voice: { provider: voiceConfig.provider, model: voiceConfig.model, referenceId: voiceConfig.referenceId, metallicMix: voiceConfig.metallicMix } };
}
module.exports = { collectSystemStatus, checkGithub, checkInstagram, checkAdministrator, checkOmniRoute, checkInternetSpeed, checkMemory, checkMood };
