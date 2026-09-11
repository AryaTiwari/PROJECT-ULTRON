#!/usr/bin/env node
const { spawnSync } = require('child_process');
const path = require('path');

function pythonCommand() {
  return process.platform === 'win32' ? 'python.exe' : 'python3';
}

function run(args, label) {
  const result = spawnSync(pythonCommand(), args, { stdio: 'inherit', cwd: process.cwd(), windowsHide: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}.`);
}

try {
  console.log('Installing the optional joeyism LinkedIn fallback in your local Python environment...');
  run(['-m', 'pip', 'install', 'linkedin_scraper==3.1.2'], 'linkedin_scraper install');
  run(['-m', 'playwright', 'install', 'chromium'], 'Playwright Chromium install');
  console.log('Starting one-time visible manual login. No LinkedIn password is stored by ULTRON.');
  run([path.join(__dirname, 'linkedin-joeyism-session.py')], 'LinkedIn manual session setup');
  console.log('Optional joeyism LinkedIn fallback is ready. Enable it with ULTRON_M3_LINKEDIN_JOEYISM_ENABLED=1.');
} catch (error) {
  console.error('LinkedIn fallback setup failed:', error.message);
  process.exitCode = 1;
}
