'use strict';

const paid = require('./paid-tool-approval');
const missionStore = require('./apollo-lead-mission-store');

const active = new Map();
const completedApprovalIds = new Set();

function text(value) { return String(value == null ? '' : value).trim(); }

function missionIdFromDecision(decision = {}) {
  return text(decision?.payload?.missionId);
}

function currentMission(id = '') {
  return id ? missionStore.get(id) : missionStore.latest();
}

function reconcile(mission) {
  if (!mission) return null;
  const phase = text(mission.currentPhase).toLowerCase();
  if (!['queued', 'running', 'discovering'].includes(phase)) return mission;
  if (active.has(mission.missionId)) return mission;

  // A background Apollo lead run is approval-scoped to one runtime. If the
  // process restarted, never pretend the mission is still running and never
  // silently replay a paid operation.
  if (mission.runnerRuntimeId && mission.runnerRuntimeId !== paid.RUNTIME_ID) {
    return missionStore.update(mission.missionId, {
      currentPhase: 'interrupted',
      safetyState: 'approval_required',
      completionReason: 'runtime_restarted_before_completion',
      lastError: {
        code: 'APOLLO_LEAD_RUN_INTERRUPTED',
        message: 'The approved Apollo lead run was interrupted by a runtime restart and was not replayed.',
      },
    });
  }

  return mission;
}

function summary(mission) {
  const m = reconcile(mission);
  if (!m) return null;
  const phase = text(m.currentPhase || 'unknown');
  return {
    missionId: m.missionId,
    missionType: m.missionType,
    phase,
    running: active.has(m.missionId),
    targetCount: Number(m.targetCount || 0),
    companyCandidatesFound: Number(m.companyCandidatesFound || 0),
    companiesQualified: Number(m.companiesQualified || 0),
    companiesSelected: Number(m.companiesSelected || 0),
    searchVariantsTried: Number(m.searchVariantsTried || 0),
    apolloCalls: Number(m.apolloCalls || 0),
    paidCalls: Number(m.paidCalls || 0),
    rowsWritten: Number(m.rowsWritten || 0),
    remainingTarget: Number.isFinite(Number(m.remainingTarget)) ? Number(m.remainingTarget) : null,
    completionReason: m.completionReason || null,
    sheetName: m.sheetName || m.compiledFilters?.sheet?.sheetName || null,
    sheetUrl: m.sheetUrl || m.compiledFilters?.sheet?.url || null,
    lastError: m.lastError || null,
    updatedAt: m.updatedAt || null,
    completedAt: m.completedAt || null,
  };
}

function progress(id = '') {
  return summary(currentMission(id));
}

function enqueue(decision, executor) {
  if (!decision || decision.status !== 'approved' || decision.operation !== 'apollo-lead-intelligence') {
    const error = new Error('A resolved Apollo lead approval is required.');
    error.code = 'APOLLO_LEAD_APPROVAL_REQUIRED';
    throw error;
  }
  if (typeof executor !== 'function') throw new TypeError('Apollo lead runner requires an executor.');

  const missionId = missionIdFromDecision(decision);
  if (!missionId) {
    const error = new Error('Apollo lead approval payload is missing missionId.');
    error.code = 'APOLLO_LEAD_MISSION_ID_REQUIRED';
    throw error;
  }

  if (active.has(missionId) || completedApprovalIds.has(decision.id)) return progress(missionId);

  missionStore.update(missionId, {
    currentPhase: 'queued',
    safetyState: 'approved',
    approvalId: decision.id,
    runnerRuntimeId: paid.RUNTIME_ID,
    startedAt: new Date().toISOString(),
    lastError: null,
  });

  const promise = new Promise((resolve) => {
    setImmediate(async () => {
      try {
        missionStore.update(missionId, {
          currentPhase: 'running',
          safetyState: 'approved',
          runnerRuntimeId: paid.RUNTIME_ID,
        });
        const result = await paid.withPermit(decision, executor);
        const latest = missionStore.get(missionId);
        missionStore.update(missionId, {
          currentPhase: latest?.currentPhase === 'completed' ? 'completed' : 'completed',
          safetyState: 'complete',
          completedAt: new Date().toISOString(),
          lastResponse: text(result?.response || result?.text),
          lastError: null,
        });
        completedApprovalIds.add(decision.id);
        resolve(result);
      } catch (error) {
        missionStore.update(missionId, {
          currentPhase: 'failed',
          safetyState: 'failed',
          completionReason: 'execution_failed',
          completedAt: new Date().toISOString(),
          lastError: {
            code: text(error?.code || 'APOLLO_LEAD_MISSION_FAILED'),
            message: text(error?.message || error || 'Apollo lead mission failed.'),
          },
        });
        completedApprovalIds.add(decision.id);
        resolve(null);
      } finally {
        active.delete(missionId);
      }
    });
  });

  active.set(missionId, promise);
  return progress(missionId);
}

function isRunning(id = '') {
  return active.has(text(id));
}

module.exports = {
  enqueue,
  progress,
  summary,
  currentMission,
  isRunning,
};
