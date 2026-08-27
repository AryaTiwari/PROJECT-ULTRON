import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const required = ['vite', '@vitejs/plugin-react', '@tailwindcss/vite', 'tailwindcss', 'react', 'react-dom', 'motion', 'prismjs'];
const missing = required.filter((name) => {
  try { require.resolve(name); return false; } catch { return true; }
});

if (missing.length) {
  console.log(`[Interface] Installing missing UI dependencies: ${missing.join(', ')}`);
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], { stdio: 'inherit' });
}
