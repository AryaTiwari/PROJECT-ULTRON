'use strict';
const controller = require('./apollo-lead-domain-controller');
const runner = require('./apollo-lead-mission-runner');

async function execute(decision) {
  if (!decision || decision.operation !== controller.OPERATION || decision.tool !== 'apollo') return null;

  if (decision.status === 'denied') {
    return controller.response(true, 'Apollo was not used. The Apollo lead mission was cancelled.', {
      paidToolApproval: decision,
      apolloCalled: false,
    });
  }
  if (decision.status !== 'approved') return null;

  try {
    const mission = runner.enqueue(
      decision,
      () => controller.executeApproved(decision.payload.compiled, decision.payload.missionId),
    );
    return controller.response(
      true,
      `Apollo lead mission ${mission.missionId} started. Ask "Apollo lead progress" for live search, qualification, call and Sheet-write status.`,
      {
        mission,
        paidToolApproval: decision,
        apolloCalled: true,
        approvalRequired: false,
        backgroundMission: true,
      },
    );
  } catch (error) {
    return controller.response(false, `Apollo lead mission stopped safely: ${error.message}`, {
      error: error.code || 'APOLLO_LEAD_MISSION_FAILED',
      paidToolApproval: decision,
    });
  }
}

module.exports = { execute };
