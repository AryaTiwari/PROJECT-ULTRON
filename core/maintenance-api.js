const fs = require('fs');
const path = require('path');
const { snapshot } = require('./inspector');
const { createPatchPlan } = require('./self-maintenance');
const { rank } = require('./model-router-stats');
const local = require('./memory/local-store');
const { config } = require('./config');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

async function maintenanceSnapshot(core) {
  return {
    ...(await snapshot(core)),
    model_ranking: rank(local.getModelPerformance(1000)),
    maintenance_policy: {
      mode: process.env.ULTRON_SELF_MAINTENANCE_ENABLED === 'true' ? 'enabled' : 'plan-only',
      auto_apply: process.env.ULTRON_SELF_UPGRADE_AUTO_APPLY === 'true',
      allowed_roots: ['core', 'tools', 'docs', 'interface'],
      rollback_required: true,
    },
  };
}

async function heal() {
  const actions = [];
  const checks = [];
  const ensure = p => {
    fs.mkdirSync(p, { recursive: true });
    actions.push(`ensured ${p}`);
  };

  try {
    ensure(path.resolve(config.memoryFile, '..'));
    ensure(path.resolve(config.conversationFile, '..'));
    ensure(path.resolve(process.env.ULTRON_TTS_OUTPUT_DIR || '.ultron/audio'));
    checks.push({ name: 'local_runtime_dirs', ok: true });
  } catch (error) {
    checks.push({ name: 'local_runtime_dirs', ok: false, error: error.message });
  }

  try {
    const { health } = require('./model-router');
    const gateway = await health();
    checks.push({ name: 'omniroute_gateway', ...gateway });
  } catch (error) {
    checks.push({ name: 'omniroute_gateway', ok: false, error: error.message });
  }

  try {
    const { available } = require('./voice/config');
    checks.push({ name: 'fish_tts_config', ok: available() });
  } catch (error) {
    checks.push({ name: 'fish_tts_config', ok: false, error: error.message });
  }

  if (process.platform === 'win32') {
    try {
      await execFileAsync('powershell.exe', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { timeout: 5000 });
      checks.push({ name: 'powershell', ok: true });
    } catch (error) {
      checks.push({ name: 'powershell', ok: false, error: error.message });
    }
  }

  return { ok: checks.every(c => c.ok !== false), checks, actions, mode: 'safe-repair-only' };
}

module.exports = { maintenanceSnapshot, createPatchPlan, heal };
