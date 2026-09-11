#!/usr/bin/env node
const { spawnSync } = require('child_process');
const policy = require('../core/linkedin-account-policy');
const mcp = require('../core/linkedin-mcp-client');

const importBrowser = process.argv.includes('--import-browser');
const command = mcp.uvxCommand();
const args = importBrowser
  ? [mcp.PACKAGE_SPEC, '--import-from-browser', 'auto']
  : [mcp.PACKAGE_SPEC, '--login'];

console.log(importBrowser
  ? 'Importing your existing local LinkedIn browser session into the dedicated LinkedIn MCP profile.'
  : 'Opening the dedicated LinkedIn MCP browser for one-time manual sign-in.');
console.log('ULTRON does not need or store your LinkedIn password. Complete any 2FA/checkpoint yourself in the visible browser.');

const result = spawnSync(command, args, {
  stdio: 'inherit',
  cwd: process.cwd(),
  windowsHide: false,
  env: { ...process.env, AUTO_IMPORT_FROM_BROWSER: 'false' },
});

if (result.error) {
  console.error('LinkedIn account setup could not start:', result.error.message);
  if (/ENOENT|not found|not recognized/i.test(result.error.message)) {
    console.error('Install uv first on Windows: winget install --id=astral-sh.uv -e');
  }
  process.exitCode = 1;
} else if (result.status !== 0) {
  console.error(`LinkedIn account setup exited with code ${result.status}.`);
  process.exitCode = result.status || 1;
} else {
  policy.clearManualLock(importBrowser ? 'explicit browser session import completed' : 'manual LinkedIn login completed');
  console.log('LinkedIn account session is ready. Safety cooldown/lock state was cleared after this explicit authentication step.');
}
