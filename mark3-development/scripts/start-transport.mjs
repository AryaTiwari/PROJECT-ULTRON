import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const mark3Dir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const projectRoot = path.resolve(mark3Dir, '..');
const require = createRequire(import.meta.url);
const credentialStore = require('../../core/credentials/local-store');

const DIRECT_KEYS = [
  'GEMINI_API_KEY', 'GEMINI_API_KEY2', 'GOOGLE_API_KEY', 'GOOGLE_API_KEY2',
  'GROQ_API_KEY', 'GROQ_API_KEY2',
  'NVIDIA_API_KEY', 'NVIDIA_API_KEY2', 'NVIDIA_NIM_API_KEY',
];

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

function launchOmniRoute() {
  const script = path.join(mark3Dir, 'scripts', 'start-mark3.mjs');
  const args = [`--env-file=${path.join(projectRoot, '.env')}`, script];
  return spawn(process.execPath, args, {
    cwd: mark3Dir,
    env: process.env,
    windowsHide: true,
    detached: false,
    stdio: 'inherit',
    shell: false,
  });
}

async function main() {
  if (await directConfigured()) {
    console.log('[Mark 3] Direct Gemini/Groq/NVIDIA credential pool detected. ULTRON will use specialist direct APIs first; OmniRoute is armed as a lazy fallback and will stay off unless direct routes fail.');
    return;
  }

  console.log('[Mark 3] No direct Gemini/Groq/NVIDIA credential detected. Starting OmniRoute as the primary fallback transport.');
  await new Promise((resolve, reject) => {
    const child = launchOmniRoute();
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
