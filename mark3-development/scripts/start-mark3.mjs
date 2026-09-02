import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const mark3Dir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

process.env.ULTRON_MODEL_PROVIDER = 'omniroute';
process.env.ULTRON_M3_DISABLE_OPENCODE = '1';
process.env.ULTRON_DISABLE_OPENCODE = '1';
process.env.ULTRON_ENABLE_OPENCODE = '0';

const child = spawn(process.execPath, ['--env-file=../.env', '../scripts/start-unified.mjs'], {
  cwd: mark3Dir,
  env: process.env,
  stdio: 'inherit',
  windowsHide: false,
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
child.on('error', (error) => {
  console.error(`[Mark 3 Launcher] ${error.message}`);
  process.exit(1);
});
