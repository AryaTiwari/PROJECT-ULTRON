const supervisor = require('./supervisor');
const governor = require('./model-governor');
const retry = require('./retry');
const preferences = require('./preferences');

let installed = false;
let originalHandle = null;

function executionRequest(message) {
  return preferences.shouldDelegate(String(message || '').trim());
}
function internalProjectStatusIntent(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!/\b(?:status|progress|how(?:'s| is)|where (?:is|are)|what(?:'s| is) happening)\b/.test(value)) return false;
  const state = supervisor.status();
  if (!state.available) return false;
  const objective = String(state.mission?.objective || '').toLowerCase();
  const named = value.split(/\s+/).filter((word) => word.length > 4).some((word) => objective.includes(word));
  return named && /\b(?:build|mission|project|automation|integration|operator|reel|creator|forge)\b/.test(value);
}
function latestStatusResponse() {
  const state = supervisor.status();
  if (!state.available) return 'Sir, no Forge mission exists yet.';
  const { mission, usage } = state;
  const jobs = Array.isArray(state.jobs) ? state.jobs : [];
  const progress = mission.progress || {};
  const objective = String(mission.objective || 'current project');
  const profile = mission.forgeProfile || preferences.classify(objective).id;
  const usageText = usage ? ` AI usage: ${usage.calls || 0} calls, ${usage.totalTokens || 0} tokens.` : '';
  const running = state.running || mission.status === 'running' ? 'running' : mission.status;
  const paused = mission.status === 'paused_inference' ? ' Free inference is paused; completed work is checkpointed. Restore a free provider/key or wait for quota recovery, then say “Resume Forge”.' : '';
  const approval = mission.status === 'awaiting_approval' ? ' A real external side effect is gated; say “Approve Forge” only if you want that exact action.' : '';
  const blockedJobs = jobs.filter((job) => ['blocked', 'failed', 'paused', 'blocked_approval'].includes(String(job.status || '')));
  const activeJobs = jobs.filter((job) => job.status === 'running');
  const activeText = activeJobs.length ? ` Active job: ${activeJobs[0].title || activeJobs[0].id}.` : '';
  const blockerText = blockedJobs.length
    ? ` ${blockedJobs.length} job${blockedJobs.length === 1 ? '' : 's'} need attention; first blocker: ${blockedJobs[0].title || blockedJobs[0].id} — ${blockedJobs[0].blockedReason || blockedJobs[0].error || 'reason not recorded'}.`
    : '';
  const workspace = mission.workspace ? ` Workspace: ${mission.workspace}.` : '';
  return `Sir, Forge is ${running} on a ${profile} mission. ${progress.completed || 0}/${progress.total || 0} jobs complete (${progress.percent || 0}%).${activeText}${blockerText}${paused}${approval}${usageText}${workspace}`;
}
function install() {
  if (installed) return { installed: true, alreadyInstalled: true };
  preferences.applyCurrentModelPool(governor);
  const assistant = require('../assistant');
  const conversation = require('../conversation');
  const voice = require('../voice-orchestrator');
  const { emit } = require('../events');
  if (!assistant?.handle) throw new Error('Assistant handle is unavailable for Forge bootstrap.');
  originalHandle = assistant.handle;

  assistant.handle = async (message, options = {}) => {
    const text = String(message || '').trim();
    const inputMode = String(options.inputMode || 'chat').toLowerCase() === 'voice' ? 'voice' : 'chat';

    const resumeId = supervisor.isResumeRequest(text);
    if (resumeId) {
      const requestedId = resumeId === true ? null : resumeId;
      const current = supervisor.status(requestedId);
      let result;
      let retriedJobs = [];
      if (current.available && ['partial', 'failed'].includes(String(current.mission?.status || ''))) {
        const retried = retry.resetRetryable(current.mission.id);
        retriedJobs = retried.resetJobs;
        result = { missionId: retried.missionId, resumedJobs: [] };
        if (retriedJobs.length) setImmediate(() => supervisor.execute(retried.missionId).catch(() => {}));
      } else {
        result = supervisor.resume(requestedId);
      }
      const detail = retriedJobs.length
        ? ` with ${retriedJobs.length} failed or dependency-blocked job${retriedJobs.length === 1 ? '' : 's'} reset while preserving completed work`
        : result.resumedJobs.length
          ? ` with ${result.resumedJobs.length} paused job${result.resumedJobs.length === 1 ? '' : 's'} restored`
          : '';
      const response = `Resumed, Sir. Forge mission ${result.missionId} is continuing from its last checkpoint${detail}.`;
      conversation.append('user', text, { taskType: 'forge-resume', inputMode });
      conversation.append('assistant', response, { model: 'forge-supervisor', provider: 'local', taskType: 'forge-resume', inputMode });
      emit('forge_resume_requested', { missionId: result.missionId, inputMode, resumedJobs: result.resumedJobs, retriedJobs });
      void voice.enqueue(response);
      return { ok: true, response, text: response, model: 'forge-supervisor', provider: 'local', taskType: 'forge-resume', mode: 'forge', inputMode, streamed: false, toolRounds: 0 };
    }

    if (supervisor.isStatusRequest(text) || /^(?:forge\s+status|mission\s+status)[?.!\s]*$/i.test(text) || internalProjectStatusIntent(text)) {
      const response = latestStatusResponse();
      conversation.append('user', text, { taskType: 'forge-status', inputMode });
      conversation.append('assistant', response, { model: 'forge-supervisor', provider: 'local', taskType: 'forge-status', inputMode });
      emit('forge_status_requested', { inputMode });
      void voice.enqueue(response);
      return { ok: true, response, text: response, model: 'forge-supervisor', provider: 'local', taskType: 'forge-status', mode: 'forge', inputMode, streamed: false, toolRounds: 0 };
    }

    const approvalId = supervisor.isApprovalRequest(text);
    if (approvalId) {
      const result = supervisor.approve(approvalId === true ? null : approvalId);
      const response = result.approvedJobs.length
        ? `Approved, Sir. Forge resumed mission ${result.missionId} with ${result.approvedJobs.length} gated job${result.approvedJobs.length === 1 ? '' : 's'}.`
        : `Sir, mission ${result.missionId} has no jobs waiting for approval.`;
      conversation.append('user', text, { taskType: 'forge-approval', inputMode });
      conversation.append('assistant', response, { model: 'forge-supervisor', provider: 'local', taskType: 'forge-approval', inputMode });
      emit('forge_approval_requested', { missionId: result.missionId, approvedJobs: result.approvedJobs, inputMode });
      void voice.enqueue(response);
      return { ok: true, response, text: response, model: 'forge-supervisor', provider: 'local', taskType: 'forge-approval', mode: 'forge', inputMode, streamed: false, toolRounds: 0 };
    }

    if (!executionRequest(text)) return originalHandle(message, options);

    const profile = preferences.classify(text);
    emit('forge_request_received', { objective: text, inputMode, forgeProfile: profile.id });
    conversation.append('user', text, { taskType: 'forge', inputMode, forgeProfile: profile.id });
    try {
      const mission = await supervisor.start(text, { source: inputMode === 'voice' ? 'voice' : 'conversation', forgeProfile: profile.id });
      const automationText = mission.automation ? ' Its automation durability contract is active.' : '';
      const response = `Understood, Sir. Forge opened a ${profile.label.toLowerCase()} mission with ${mission.progress?.total || 0} focused jobs. It is executing with checkpoints, independent review, bounded repair and zero-cost cloud inference only.${automationText} Say “Forge status” for progress.`;
      conversation.append('assistant', response, { model: 'forge-supervisor', provider: 'local+nvidia', taskType: 'forge', missionId: mission.id, inputMode, forgeProfile: profile.id });
      emit('forge_mission_accepted', { missionId: mission.id, jobs: mission.progress?.total || 0, workspace: mission.workspace, automation: Boolean(mission.automation), forgeProfile: profile.id });
      void voice.enqueue(response);
      return { ok: true, response, text: response, model: 'forge-supervisor', provider: 'local+nvidia', taskType: 'forge', mode: 'forge', missionId: mission.id, workspace: mission.workspace, inputMode, forgeProfile: profile.id, streamed: false, toolRounds: 0 };
    } catch (error) {
      const response = `Sir, Forge could not open the mission: ${error.message}`;
      conversation.append('assistant', response, { model: 'forge-supervisor', provider: 'local', taskType: 'forge', inputMode, error: true });
      void voice.enqueue(response);
      return { ok: false, response, text: response, model: 'forge-supervisor', provider: 'local', taskType: 'forge', mode: 'forge', inputMode, error: error.message };
    }
  };

  installed = true;
  const recovered = supervisor.recover();
  emit('forge_ready', { recovered, governor: governor.status(), profiles: Object.keys(preferences.PROFILES) });
  return { installed: true, recovered, governor: governor.status(), profiles: Object.keys(preferences.PROFILES) };
}
function uninstall() {
  if (!installed) return;
  const assistant = require('../assistant');
  if (originalHandle) assistant.handle = originalHandle;
  originalHandle = null;
  installed = false;
}
function status() { return { installed, governor: governor.status(), latestMission: supervisor.status(), missionProfiles: Object.keys(preferences.PROFILES) }; }

module.exports = { install, uninstall, status, executionRequest, internalProjectStatusIntent, latestStatusResponse };
