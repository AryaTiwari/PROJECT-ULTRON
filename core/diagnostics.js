const fs = require('fs');
const path = require('path');
const { health } = require('./model-router');
const { available: fishAvailable } = require('./voice/config');
const { config } = require('./config');

async function diagnose() {
  const checks = [];
  const exists = p => fs.existsSync(p);
  checks.push({ name: 'node', ok: Number(process.versions.node.split('.')[0]) >= 18, value: process.versions.node });
  checks.push({ name: 'runtime_dirs', ok: (() => { try { fs.mkdirSync(path.dirname(config.memoryFile), { recursive: true }); return true; } catch { return false; } })() });
  checks.push({ name: 'omniroute', ...(await health()) });
  checks.push({ name: 'omniroute_key', ok: Boolean(config.router.apiKey) });
  checks.push({ name: 'fish_tts', ok: fishAvailable() });
  checks.push({ name: 'voice_listener_script', ok: process.platform !== 'win32' || exists(path.join(__dirname, 'voice', 'windows-listener.ps1')) });
  checks.push({ name: 'supabase', ok: Boolean(config.supabase.url && config.supabase.key) });
  return { ok: checks.every(c => c.ok !== false), generated_at: new Date().toISOString(), checks };
}

if (require.main === module) diagnose().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { diagnose };
