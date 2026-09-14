#!/usr/bin/env node
const { spawnSync } = require('child_process');
const mcp = require('../core/linkedin-mcp-client');
const policy = require('../core/linkedin-account-policy');
const joeyism = require('../core/linkedin-joeyism-bridge');

function fail(message, detail = null) {
  console.error(message);
  if (detail) console.error(detail);
  process.exitCode = 1;
}

async function main() {
  console.log('LinkedIn account integration policy:', policy.status());
  console.log('Primary backend:', mcp.status());
  console.log('Optional fallback:', joeyism.status());
  console.log('');
  console.log('[1/3] Checking uvx + LinkedIn MCP package + stored LinkedIn session...');

  const result = spawnSync(mcp.uvxCommand(), [mcp.PACKAGE_SPEC, '--status'], {
    stdio: 'inherit',
    cwd: process.cwd(),
    windowsHide: false,
    env: {
      ...process.env,
      UV_HTTP_TIMEOUT: String(process.env.UV_HTTP_TIMEOUT || 300),
      AUTO_IMPORT_FROM_BROWSER: 'false',
    },
  });

  if (result.error) {
    fail('LinkedIn MCP doctor could not start uvx.', result.error.message);
    if (/ENOENT|not found|not recognized/i.test(result.error.message)) {
      console.error('Install uv on Windows: winget install --id=astral-sh.uv -e');
    }
    return;
  }

  if (result.status !== 0) {
    fail(
      'The LinkedIn MCP package is reachable, but its stored LinkedIn session is not currently valid.',
      'Run npm run linkedin:setup, complete login/2FA/checkpoint in the visible browser, then rerun npm run linkedin:status.'
    );
    return;
  }

  console.log('[PASS] Stored LinkedIn session validation passed.');
  console.log('');
  console.log('[2/3] Starting ULTRON through the official MCP stdio client...');

  try {
    await mcp.ensureServer();
  } catch (error) {
    fail(
      `ULTRON could not establish the stdio MCP connection: ${error.code || 'LINKEDIN_MCP_CONNECT_FAILED'}`,
      error.message
    );
    return;
  }

  console.log('[PASS] MCP stdio connection established.');
  console.log('');
  console.log('[3/3] Verifying LinkedIn MCP tool contract...');

  try {
    const tools = await mcp.listTools();
    const names = tools.map((tool) => String(tool?.name || '')).filter(Boolean);
    const missing = mcp.REQUIRED_TOOLS.filter((name) => !names.includes(name));
    console.log('Published LinkedIn MCP tools:', names.join(', '));
    if (missing.length) {
      fail('Required LinkedIn tools are missing from the connected MCP server.', missing.join(', '));
      return;
    }
    console.log('[PASS] Required LinkedIn tools are available:', mcp.REQUIRED_TOOLS.join(', '));
    console.log('');
    console.log('LINKEDIN MCP DOCTOR: PASS');
    console.log(JSON.stringify(mcp.status(), null, 2));
  } catch (error) {
    fail('MCP connected, but tool discovery failed.', error.message);
  } finally {
    await mcp.shutdown();
  }
}

main().catch((error) => {
  fail('LinkedIn MCP doctor crashed.', error?.stack || error?.message || String(error));
});
