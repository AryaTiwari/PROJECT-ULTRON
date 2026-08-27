import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const required = ['vite', '@vitejs/plugin-react', '@tailwindcss/vite', 'tailwindcss', 'react', 'react-dom', 'motion', 'prismjs'];
const missing = required.filter((name) => {
  try {
    require.resolve(name);
    return false;
  } catch {
    return true;
  }
});

if (missing.length) {
  console.log(`[Interface] Installing missing UI dependencies: ${missing.join(', ')}`);
  if (process.platform === 'win32') {
    // npm.cmd is a Windows shell shim. Node 26 can reject direct execFileSync on it
    // with EINVAL, so invoke npm through cmd.exe instead.
    execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm install --no-audit --no-fund'], {
      stdio: 'inherit',
      windowsHide: false,
    });
  } else {
    execFileSync('npm', ['install', '--no-audit', '--no-fund'], { stdio: 'inherit' });
  }
}
