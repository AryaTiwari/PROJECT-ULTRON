const supervisor = require('./supervisor');
const governor = require('./model-governor');

let installed = false;
let originalHandle = null;

function executionRequest(message) {
  const text = String(message || '').trim();
  if (/\b(?:how do i|how can i|how should i|explain|teach me|guide me|what is|what are)\b/i.test(text)) return false;
  return supervisor.shouldUse(text);
}
function latestStatusResponse() {
  const state = supervisor.status();
  if (!state.available) return 'Sir, no Forge mission exists yet.';
  const { mission, usage } = state;
  const jobs = Array.isArray(state.jobs) ? state.jobs : [];
  const progress = mission.progress || {};
  const usageText = usage ? ` Inference usage: ${usage.calls || 0} calls, ${usage.totalTokens || 0} tokens.` : '';
  const running = state.running || mission.status === 'running' ? 'running' : mission.status;
  const paused = mission.status === 'paused_inference' ? ' Free inference is paused; restore an allowed free key or wait for quota recovery, then say “Resume Forge”.' : '';
  const approval = mission.status === 'awaiting_approval' ? ' A gated external side effect is waiting; say “Approve Forge” only if you want it executed.' : '';
  const automation = mission.automation ? ' Automation durability contract is active.' : '';
  const repair = mission.repairCycles ? ` Repair cycles used: ${mission.repairCycles}.` : '';
  const blockedJobs = jobs.filter((job) => ['blocked', 'failed', 'paused', 'blocked_approval'].includes(String(job.status || '')));
  const activeJobs = jobs.filter((job) => job.status === 'running');
  const blockerText = blockedJobs.length
    ? ` Blocked/failed jobs: ${blockedJobs.slice(0, 3).map((job) => `${job.title || job.id} [${job.status}: ${job.blockedReason || job.error || 'no reason recorded'}]`).join('; ')}${blockedJobs.length > 3 ? `; +${blockedJobs.length - 3} more` : ''}.`
    : '';
  const activeText = activeJobs.length ? ` Active job: ${activeJobs[0].title || activeJobs[0].id}.` : '';
  const workspace = ['completed', 'partial', 'failed', 'paused_inference'].includes(mission.status) ? ` Workspace: ${mission.workspace}.` : '';
  return `Sir, Forge mission ${mission.id} is ${running}: ${progress.completed || 0}/${progress.total || 0} jobs complete (${progress.percent || 0}%).${activeText}${mission.error ? ` Current issue: ${mission.error}` : ''}${blockerText}${paused}${approval}${automation}${repair}${usageText}${workspace}`;
}
function install() {
  if (installed) return { installed: true, alreadyInstalled: true };
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
      const result = supervisor.resume(resumeId === true ? null : resumeId);
      const response = `Resumed, Sir. Forge mission ${result.missionId} is continuing from its last checkpoint${result.resumedJobs.length ? ` with ${result.resumedJobs.length} paused job${result.resumedJobs.length === 1 ? '' : 's'} restored` : ''}.`;
      conversation.append('user', text, { taskType: 'forge-resume', inputMode });
      conversation.append('assistant', response, { model: 'forge-supervisor', provider: 'local', taskType: 'forge-resume', inputMode });
      emit('forge_resume_requested', { missionId: result.missionId, inputMode });
      void voice.enqueue(response);
      return { ok: true, response, text: response, model: 'forge-supervisor', provider: 'local', taskType: 'forge-resume', mode: 'forge', inputMode, streamed: false, toolRounds: 0 };
    }

    if (supervisor.isStatusRequest(text) || /^(?:forge\s+status|mission\s+status)[?.!\s]*$/i.test(text)) {
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

    emit('forge_request_received', { objective: text, inputMode });
    conversation.append('user', text, { taskType: 'forge', inputMode });
    try {
      const mission = await supervisor.start(text, { source: inputMode === 'voice' ? 'voice' : 'conversation' });
      const automationText = mission.automation ? ' Its automation durability contract is active.' : '';
      const response = `Understood, Sir. Forge opened mission ${mission.id} with ${mission.progress?.total || 0} specialist jobs in an isolated workspace. It is executing with checkpoints, independent review, bounded repair cycles and zero-cost cloud inference only.${automationText} Say “Forge status” for progress.`;
      conversation.append('assistant', response, { model: 'forge-supervisor', provider: 'local+nvidia', taskType: 'forge', missionId: mission.id, inputMode });
      emit('forge_mission_accepted', { missionId: mission.id, jobs: mission.progress?.total || 0, workspace: mission.workspace, automation: Boolean(mission.automation) });
      void voice.enqueue(response);
      return { ok: true, response, text: response, model: 'forge-supervisor', provider: 'local+nvidia', taskType: 'forge', mode: 'forge', missionId: mission.id, workspace: mission.workspace, inputMode, streamed: false, toolRounds: 0 };
    } catch (error) {
      const response = `Sir, Forge could not open the mission: ${error.message}`;
      conversation.append('assistant', response, { model: 'forge-supervisor', provider: 'local', taskType: 'forge', inputMode, error: true });
      void voice.enqueue(response);
      return { ok: false, response, text: response, model: 'forge-supervisor', provider: 'local', taskType: 'forge', mode: 'forge', inputMode, error: error.message };
    }
  };

  installed = true;
  const recovered = supervisor.recover();
  emit('forge_ready', { recovered, governor: governor.status() });
  return { installed: true, recovered, governor: governor.status() };
}
function uninstall() {
  if (!installed) return;
  const assistant = require('../assistant');
  if (originalHandle) assistant.handle = originalHandle;
  originalHandle = null;
  installed = false;
}
function status() { return { installed, governor: governor.status(), latestMission: supervisor.status() }; }

module.exports = { install, uninstall, status, executionRequest, latestStatusResponse };
