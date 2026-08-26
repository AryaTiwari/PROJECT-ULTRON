const { snapshot } = require('./inspector');
const { createPatchPlan } = require('./self-maintenance');
const { rank } = require('./model-router-stats');
const local = require('./memory/local-store');

async function maintenanceSnapshot(core) {
  return {
    ...(await snapshot(core)),
    model_ranking: rank(local.getModelPerformance(1000)),
    maintenance_policy: {
      mode: 'plan-only',
      auto_apply: false,
      allowed_roots: ['core', 'tools', 'docs', 'interface'],
      rollback_required: true,
    },
  };
}

module.exports = { maintenanceSnapshot, createPatchPlan };
