'use strict';
const http = require('node:http');
const config = require('../core/config');
const build = require('../core/runtime-build');

function classify(health, currentBuildId = build.id) {
  if (!health || health.service !== 'ULTRON Mark 3') return 'foreign';
  return health.buildId === currentBuildId ? 'current' : 'stale';
}

function probe(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const request = http.get({ host: config.host, port: config.port, path: '/api/health', timeout: timeoutMs }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => {
        try { resolve({ reachable: true, health: JSON.parse(raw), status: response.statusCode }); }
        catch { resolve({ reachable: true, health: null, status: response.statusCode }); }
      });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve({ reachable: false, health: null, status: null }));
  });
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitUntilStopped(pid, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return true; }
    await wait(100);
  }
  return false;
}

async function replaceStale() {
  const existing = await probe();
  if (!existing.reachable) return { action: 'none' };
  const state = classify(existing.health);
  if (state === 'foreign') throw new Error(`Port ${config.port} is occupied by a service that is not ULTRON Mark 3.`);
  if (state === 'current') {
    console.log(`[Mark 3] Current ULTRON build ${build.id} is already running on port ${config.port}.`);
    return { action: 'current', pid: existing.health.pid };
  }
  const pid = Number(existing.health.pid);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) throw new Error('The stale ULTRON instance did not provide a safe process ID for replacement.');
  console.log(`[Mark 3] Replacing stale ULTRON PID ${pid} (${existing.health.buildId || 'legacy build'}) with ${build.id}.`);
  process.kill(pid, 'SIGTERM');
  if (!await waitUntilStopped(pid)) throw new Error(`Stale ULTRON PID ${pid} did not stop within the replacement window.`);
  return { action: 'replaced', pid };
}

if (require.main === module) replaceStale().catch((error) => { console.error(`[Mark 3] ${error.message}`); process.exitCode = 1; });
module.exports = { classify, probe, waitUntilStopped, replaceStale };