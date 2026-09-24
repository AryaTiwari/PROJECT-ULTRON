'use strict';
const paid = require('./paid-tool-approval');
const controller = require('./apollo-lead-domain-controller');
const missionStore = require('./apollo-lead-mission-store');
async function execute(decision) {
  if (!decision || decision.operation !== controller.OPERATION || decision.tool !== 'apollo') return null;
  if (decision.status === 'denied') return controller.response(true, 'Apollo was not used. The Apollo lead mission was cancelled.', { paidToolApproval: decision, apolloCalled: false });
  if (decision.status !== 'approved') return null;
  const missionId = decision.payload.missionId;
  const mission = missionStore.update(missionId, { currentPhase: 'queued', safetyState: 'approved', startedAt: new Date().toISOString() });
  const task = paid.withPermit(decision, () => controller.executeApproved(decision.payload.compiled, missionId));
  controller.track(missionId, task);
  return controller.response(true, `Apollo lead mission ${missionId} started in the background. Ask “Apollo lead progress” for live queries, candidates, qualified companies, calls and Sheet rows.`, { mission, paidToolApproval: decision, apolloCalled: true, background: true });
}
module.exports = { execute };