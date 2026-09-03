import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const mark3Dir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const projectRoot = path.resolve(mark3Dir, '..');
const require = createRequire(import.meta.url);
const credentialStore = require('../../core/credentials/local-store');

const DIRECT_KEYS = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GROQ_API_KEY', 'NVIDIA_API_KEY', 'NVIDIA_NIM_API_KEY'];

async function directConfigured() {
  if (/^(0|false|no|off)$/i.test(String(process.env.ULTRON_M3_DIRECT_ENABLED || '1'))) return false;
  if (DIRECT_KEYS.some((key) => String(process.env[key] || '').trim())) return true;
  try {
    const stored = await credentialStore.load();
    return DIRECT_KEYS.some((key) => String(stored?.[key] || '').trim());
  } catch {
    return false;
  }
}

function launch({ detached, stdio }) {
  const script = path.join(mark3Dir, 'scripts', 'start-mark3.mjs');
  const args = [`--env-file=${path.join(projectRoot, '.env')}`, script];
  const child = spawn(process.execPath, args, {
    cwd: mark3Dir,
    env: process.env,
    windowsHide: true,
    detached,
    stdio,
    shell: false,
  });
  return child;
}

async function main() {
  if (await directConfigured()) {
    const child = launch({ detached: true, stdio: 'ignore' });
    child.once('error', (error) => console.warn(`[Mark 3] OmniRoute fallback warm-up could not start: ${error.message}`));
    child.unref();
    console.log('[Mark 3] Direct Gemini/Groq/NVIDIA transport detected. Starting immediately; OmniRoute is warming in the background as fallback.');
    return;
  }

  console.log('[Mark 3] No direct Gemini/Groq/NVIDIA credential detected. Waiting for OmniRoute fallback to become ready.');
  await new Promise((resolve, reject) => {
    const child = launch({ detached: false, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`OmniRoute startup exited with ${signal ? `signal ${signal}` : `code ${code}`}.`));
    });
  });
}

main().catch((error) => {
  console.error(`[Mark 3] Model transport startup failed: ${error.message}`);
  process.exit(1);
});
