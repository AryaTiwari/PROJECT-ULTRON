#!/usr/bin/env node
const { spawnSync } = require('child_process');
const mcp = require('../core/linkedin-mcp-client');
const policy = require('../core/linkedin-account-policy');
const joeyism = require('../core/linkedin-joeyism-bridge');

console.log('LinkedIn account integration policy:', policy.status());
console.log('Primary backend:', mcp.status());
console.log('Optional fallback:', joeyism.status());

const result = spawnSync(mcp.uvxCommand(), [mcp.PACKAGE_SPEC, '--status'], {
  stdio: 'inherit',
  cwd: process.cwd(),
  windowsHide: false,
  env: { ...process.env, AUTO_IMPORT_FROM_BROWSER: 'false' },
});

if (result.error) {
  console.error('LinkedIn MCP doctor could not start:', result.error.message);
  if (/ENOENT|not found|not recognized/i.test(result.error.message)) {
    console.error('Install uv first on Windows: winget install --id=astral-sh.uv -e');
  }
  process.exitCode = 1;
} else if (result.status !== 0) {
  console.error('LinkedIn MCP is installed/reachable through uvx, but the stored LinkedIn session is not currently valid.');
  process.exitCode = result.status || 1;
} else {
  console.log('LinkedIn MCP stored session validation passed.');
}
