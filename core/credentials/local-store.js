const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(process.env.ULTRON_DATA_DIR || path.join(os.homedir(), '.ultron'));
const file = path.join(root, 'credentials.dpapi.json');

function ensureRoot() { fs.mkdirSync(root, { recursive: true, mode: 0o700 }); }
function assertWindows() { if (process.platform !== 'win32') throw new Error('Local credential storage currently requires Windows DPAPI.'); }

function powershell(script, input = '') {
  assertWindows();
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `PowerShell exited with code ${code}`)));
    child.stdin.end(String(input));
  });
}

async function protect(value) {
  return powershell('$inputValue = [Console]::In.ReadToEnd(); $s = ConvertTo-SecureString -String $inputValue -AsPlainText -Force; $s | ConvertFrom-SecureString', value);
}

async function unprotect(value) {
  return powershell('$s = ConvertTo-SecureString -String ([Console]::In.ReadToEnd()); $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }', value);
}

async function load() {
  ensureRoot();
  if (!fs.existsSync(file)) return {};
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = {};
  for (const [key, encrypted] of Object.entries(raw)) {
    try { out[key] = await unprotect(encrypted); } catch { out[key] = ''; }
  }
  return out;
}

async function setMany(values) {
  ensureRoot();
  const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  for (const [key, value] of Object.entries(values || {})) {
    if (value == null || String(value) === '') continue;
    current[key] = await protect(String(value));
  }
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(current, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
  return { stored: Object.keys(values || {}).filter(key => values[key] != null && String(values[key]) !== '') };
}

async function status() {
  ensureRoot();
  let count = 0;
  if (fs.existsSync(file)) { try { count = Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).length; } catch {} }
  return { configured: fs.existsSync(file), credentialCount: count, storage: 'windows-dpapi', path: file };
}

module.exports = { load, setMany, status, file };
