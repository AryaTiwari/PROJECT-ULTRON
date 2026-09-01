import net from 'node:net';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const HOST = process.env.OMNIROUTE_HOST || '127.0.0.1';
const PORT = Number(process.env.OMNIROUTE_PORT || 20128);

function isOpen() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: HOST, port: PORT });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(900, () => done(false));
  });
}

async function stopWindowsPort() {
  if (process.platform !== 'win32') return false;
  const script = `$c=Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; if($c){$c|ForEach-Object{Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue}; Write-Output 'stopped'} else {Write-Output 'none'}`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
  if (result.status !== 0) throw new Error(result.stderr || 'Unable to stop the existing OmniRoute process.');
  return result.stdout.trim() === 'stopped';
}

async function stopUnixPort() {
  if (process.platform === 'win32') return false;
  const result = spawnSync('sh', ['-lc', `pids=$(lsof -tiTCP:${PORT} -sTCP:LISTEN 2>/dev/null || true); [ -z "$pids" ] || kill $pids`], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
  if (result.status !== 0) throw new Error(result.stderr || 'Unable to stop the existing OmniRoute process.');
  return true;
}

if (await isOpen()) {
  const stopped = process.platform === 'win32' ? await stopWindowsPort() : await stopUnixPort();
  console.log(`[Mark 3] Existing OmniRoute ${stopped ? 'stopped' : 'not stopped'} on ${HOST}:${PORT}.`);
}

console.log('[Mark 3] OmniRoute will be restarted by the normal startup script with the current bridge environment.');
