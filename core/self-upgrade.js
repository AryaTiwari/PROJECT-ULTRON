const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function run(cmd, args) {
  return execFileSync(cmd, args, { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function main() {
  if (process.env.ULTRON_SELF_UPGRADE_ENABLED !== 'true') {
    console.log(JSON.stringify({ ok: false, mode: 'disabled', message: 'Set ULTRON_SELF_UPGRADE_ENABLED=true to enable controlled upgrades.' }, null, 2));
    return;
  }
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `ultron-backup-${stamp}`;
  run('git', ['branch', backup]);
  const diagnostics = run(process.platform === 'win32' ? 'node.exe' : 'node', ['core/diagnostics.js']);
  const coreCheck = run(process.platform === 'win32' ? 'node.exe' : 'node', ['core/smoke-test.js']);
  const memoryCheck = run(process.platform === 'win32' ? 'node.exe' : 'node', ['core/memory-smoke-test.js']);
  const report = { ok: true, current_branch: branch, backup_branch: backup, diagnostics: JSON.parse(diagnostics), core_check: JSON.parse(coreCheck), memory_check: JSON.parse(memoryCheck), action: 'backup-and-validate-only' };
  fs.writeFileSync(path.join('.ultron', 'last-upgrade-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

try { main(); } catch (error) { console.error(JSON.stringify({ ok: false, error: error.message }, null, 2)); process.exitCode = 1; }
