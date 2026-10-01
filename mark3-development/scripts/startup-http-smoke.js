#!/usr/bin/env node
'use strict';

// CI-only actual npm-start boot smoke. Uses a disposable local port, a dummy
// direct transport key (no provider call), no LinkedIn auto-start and no
// enrichment operations. Verifies the REAL launch chain reaches /api/runtime.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const http = require('node:http');
const path = require('node:path');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}
function readRuntime(port) {
  return new Promise((resolve) => {
    const request = http.get({
      host: '127.0.0.1', port, path: '/api/runtime', timeout: 1200,
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(text) }); }
        catch { resolve(null); }
      });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(null));
  });
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function main() {
  const port = await freePort();
  const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const child = spawn(npmExecutable, ['start'], {
    cwd: path.join(__dirname, '..'),
    shell: process.platform === 'win32',
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ULTRON_M3_HOST: '127.0.0.1',
      ULTRON_M3_PORT: String(port),
      ULTRON_M3_LINKEDIN_AUTOSTART: '0',
      ULTRON_M3_CODING_BRAIN_AUTOSTART: '0',
      ULTRON_M3_LEAGUE_ENABLED: '0',
      ULTRON_M3_LEAGUE_ARENA_ENABLED: '0',
      // Transport readiness only; do not send a provider request.
      GEMINI_API_KEY: 'CI_STARTUP_SMOKE_NO_NETWORK',
    },
  });
  let output = '';
  let exited = false;
  child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-18000); });
  child.stderr.on('data', (chunk) => { output = (output + chunk).slice(-18000); });
  child.once('exit', () => { exited = true; });
  try {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (exited) throw new Error('npm start exited before its HTTP runtime became ready.\n' + output.slice(-4500));
      const health = await readRuntime(port);
      if (health?.status === 200 && health.body?.service === 'ULTRON Mark 3') {
        assert.equal(health.body.ok, true);
        assert.equal(health.body.version, '3.0.0-beta.22');
        assert.ok(health.body.buildId, 'server must expose a runtime build ID');
        assert.ok(Number.isInteger(health.body.pid) && health.body.pid > 0);
        console.log('Mark 3 actual npm-start HTTP smoke passed: application launched and /api/runtime returned the current build. No Apollo, Sheets or model API request was initiated by this test.');
        return;
      }
      await sleep(350);
    }
    throw new Error('npm start did not become HTTP-ready within the smoke window.\n' + output.slice(-4500));
  } finally {
    if (process.platform !== 'win32') {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
    } else {
      try { child.kill('SIGTERM'); } catch {}
    }
  }
}
main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
