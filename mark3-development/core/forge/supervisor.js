const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const store = require('./mission-store');
const compiler = require('./mission-compiler');
const factory = require('./agent-factory');
const governor = require('./model-governor');
const automation = require('./automation-blueprint');
const codingBrain = require('../coding-brain');
const { emit } = require('../events');

const active = new Map();
const MAX_ATTEMPTS = Math.max(1, Math.min(4, Number(process.env.ULTRON_M3_FORGE_JOB_ATTEMPTS || 2)));
const MAX_REPAIR_CYCLES = Math.max(0, Math.min(3, Number(process.env.ULTRON_M3_FORGE_REPAIR_CYCLES || 2)));
const CONTEXT_CHARS = Math.max(4000, Number(process.env.ULTRON_M3_FORGE_JOB_CONTEXT_CHARS || 18000));

function shouldUse(message) {
  const text = String(message || '').toLowerCase();
  if (/\b(?:forge|agent factory|multi[- ]agent|team of agents|ai agents)\b/.test(text)) return true;
  const action = /\b(?:build|create|make|develop|automate|implement|design)\b/.test(text);
  const scale = /\b(?:complete|full|entire|big|large|end[- ]to[- ]end|from scratch|project|system|platform|app|application|program|automation|workflow|pipeline|agent|agents|saas|crm|dashboard)\b/.test(text);
  const delegation = /\b(?:do it for me|handle it|take care of|finish it|complete it|autonomously|automatically)\b/.test(text);
  return action && (scale || delegation);
}
function isStatusRequest(message) {
  return /\b(?:forge|mission)\b.*\b(?:status|progress|pending|running|what.*doing)\b/i.test(String(message || ''));
}
function isApprovalRequest(message) {
  const text = String(message || '').trim();
  if (!/\bapprove\b/i.test(text) || !/\b(?:forge|mission|job|continue|it)\b/i.test(text)) return null;
  const match = text.match(/\bapprove\s+(?:forge\s+|mission\s+)?([a-zA-Z0-9._-]{8,})\b/i);
  return match ? match[1] : true;
}
function isResumeRequest(message) {
  const text = String(message || '').trim();
  const match = text.match(/\bresume\s+(?:forge|mission)(?:\s+([a-zA-Z0-9._-]+))?/i);
  return match ? (match[1] || true) : null;
}
function externalSideEffect(text) {
  return /\b(?:deploy\s+(?:to\s+)?production|publish\s+publicly|send\s+(?:emails?|messages?|dms?)|mass\s*(?:email|message|dm)|delete\s+(?:production|database)|drop\s+(?:table|database)|purchase|pay|charge|spend\s+money|transfer\s+money)\b/i.test(String(text || ''));
}
function inferenceResourceError(error) {
  return /^FORGE_(?:BUDGET|NO_NVIDIA_KEY|NVIDIA_UNAVAILABLE)/.test(String(error?.message || error || ''));
}
function initWorkspace(workspace) {
  fs.mkdirSync(workspace, { recursive: true });
  if (!fs.existsSync(path.join(workspace, '.git'))) {
    try { spawnSync('git', ['init', '--quiet'], { cwd: workspace, windowsHide: true, timeout: 10000 }); } catch {}
  }
}
function completedContext(missionId, jobs, currentJob) {
  const dependencyIds = new Set(currentJob.dependsOn || []);
  const rows = jobs
    .filter((job) => job.status === 'completed' && (dependencyIds.has(job.id) || !dependencyIds.size))
    .slice(-8);
  const text = rows.map((job) => `### ${job.title}\n${String(job.output?.summary || job.output?.text || JSON.stringify(job.output || {})).slice(0, 5000)}`).join('\n\n');
  return text.slice(-CONTEXT_CHARS);
}
function updateProgress(missionId, jobs, patch = {}) {
  const total = jobs.length;
  const completed = jobs.filter((job) => job.status === 'completed').length;
  const failed = jobs.filter((job) => job.status === 'failed').length;
  const running = jobs.filter((job) => job.status === 'running').length;
  const blocked = jobs.filter((job) => /^blocked/.test(String(job.status || ''))).length;
  const paused = jobs.filter((job) => job.status === 'paused').length;
  const progress = { total, completed, failed, running, blocked, paused, percent: total ? Math.round((completed / total) * 100) : 0 };
  return store.checkpoint(missionId, { ...patch, progress });
}
function saveJob(missionId, jobs, job, patch) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  store.saveJobs(missionId, jobs);
  store.event(missionId, 'job_updated', { jobId: job.id, status: job.status, attempts: job.attempts, error: job.error || null });
  updateProgress(missionId, jobs);
  emit('forge_job_updated', { missionId, jobId: job.id, status: job.status, title: job.title });
}
function agentFor(missionId, jobId) {
  return store.agents(missionId).find((agent) => agent.jobId === jobId);
}
async function reasoningWorker(mission, job, agent, jobs) {
  const context = completedContext(mission.id, jobs, job);
  const result = await governor.nvidiaChat({
    missionId: mission.id,
    role: agent.modelRole || 'architecture',
    temperature: 0.2,
    maxTokens: 7000,
    messages: [
      { role: 'system', content: `You are ${agent.title}, a specialist worker inside ULTRON FORGE. ${agent.instructions} Return a concrete implementation-grade deliverable. Do not claim tools/actions you did not execute.` },
      { role: 'user', content: `MISSION: ${mission.objective}\nYOUR JOB: ${job.objective}\nACCEPTANCE: ${(job.acceptance || []).join('; ') || 'Produce an actionable verified deliverable.'}\nAUTOMATION CONTRACT: ${mission.automation ? JSON.stringify(mission.automation) : 'not an automation mission'}\nPREDECESSOR OUTPUTS:\n${context || 'None.'}` },
    ],
  });
  return { summary: result.text, text: result.text, model: result.model, provider: result.provider, usage: result.usage };
}
async function codingWorker(mission, job, agent, jobs) {
  initWorkspace(mission.workspace);
  const context = completedContext(mission.id, jobs, job);
  const automationInstruction = automation.workerInstruction(mission.objective);
  const task = [
    `ULTRON FORGE MISSION: ${mission.objective}`,
    `SPECIALIST: ${agent.title}`,
    `JOB: ${job.objective}`,
    `INSTRUCTIONS: ${agent.instructions}`,
    `ACCEPTANCE: ${(job.acceptance || []).join('; ') || 'Implement the requested job and validate it.'}`,
    automationInstruction,
    context ? `DEPENDENCY CONTEXT:\n${context}` : '',
    'Work only inside the supplied workspace. Implement real files/code, run the strongest available validation, preserve working code, and report exact changed files plus test evidence. Do not deploy, send messages, spend money or perform external irreversible actions.',
  ].filter(Boolean).join('\n\n');
  const result = await codingBrain.run(task, { workspace: mission.workspace, mode: 'apply' });
  if (!result?.ok) throw new Error(result?.error || result?.summary || 'Coding Brain job failed.');
  return {
    summary: codingBrain.summarize(result),
    changedFiles: result.changedFiles || [],
    validation: result.validation || null,
    review: result.review || null,
    publish: result.publish || null,
    worker: 'coding-brain',
  };
}
async function reviewWorker(mission, job, agent, jobs) {
  initWorkspace(mission.workspace);
  let inspection = null;
  try {
    inspection = await codingBrain.run(`Inspect the current workspace for this mission without editing files. Mission: ${mission.objective}. Review objective: ${job.objective}. Check implementation completeness, tests, regressions, restart safety, automation idempotency when relevant, and concrete evidence.`, { workspace: mission.workspace, mode: 'plan' });
  } catch (error) {
    inspection = { ok: false, error: error.message };
  }
  const context = completedContext(mission.id, jobs, job);
  const critique = await governor.nvidiaChat({
    missionId: mission.id,
    role: agent.modelRole || 'code_review',
    temperature: 0.1,
    maxTokens: 6000,
    messages: [
      { role: 'system', content: `You are ${agent.title}, an independent reviewer inside ULTRON FORGE. ${agent.instructions} Be skeptical. Separate verified evidence from claims. End with VERDICT: PASS, VERDICT: NEEDS_FIXES, or VERDICT: BLOCKED.` },
      { role: 'user', content: `MISSION: ${mission.objective}\nREVIEW JOB: ${job.objective}\nAUTOMATION CONTRACT: ${mission.automation ? JSON.stringify(mission.automation) : 'not applicable'}\nPREDECESSOR OUTPUTS:\n${context || 'None'}\nCODING-BRAIN INSPECTION:\n${JSON.stringify(inspection).slice(0, 12000)}` },
    ],
  });
  const verdictMatch = critique.text.match(/VERDICT:\s*(PASS|NEEDS_FIXES|BLOCKED)/i);
  return { summary: critique.text, text: critique.text, verdict: verdictMatch ? verdictMatch[1].toUpperCase() : 'UNRESOLVED', model: critique.model, inspection };
}
async function runJob(mission, jobs, job) {
  const agent = agentFor(mission.id, job.id) || factory.create(job, mission);
  if (externalSideEffect(job.objective) && !job.approvedAt) {
    saveJob(mission.id, jobs, job, { status: 'blocked_approval', blockedReason: 'external-side-effect', agentId: agent.id });
    return { blocked: true };
  }
  saveJob(mission.id, jobs, job, { status: 'running', attempts: Number(job.attempts || 0) + 1, agentId: agent.id, error: null });
  try {
    let output;
    if (agent.worker === 'coding') output = await codingWorker(mission, job, agent, jobs);
    else if (agent.worker === 'review') output = await reviewWorker(mission, job, agent, jobs);
    else output = await reasoningWorker(mission, job, agent, jobs);
    saveJob(mission.id, jobs, job, { status: 'completed', output, completedAt: new Date().toISOString() });
    return { ok: true, output };
  } catch (error) {
    if (inferenceResourceError(error)) {
      saveJob(mission.id, jobs, job, { status: 'paused', error: error.message, pausedReason: 'free-inference-unavailable' });
      return { ok: false, paused: true, error };
    }
    const retry = Number(job.attempts || 0) < MAX_ATTEMPTS;
    saveJob(mission.id, jobs, job, { status: retry ? 'pending' : 'failed', error: error.message });
    return { ok: false, retry, error };
  }
}
function readyJobs(jobs) {
  const completed = new Set(jobs.filter((job) => job.status === 'completed').map((job) => job.id));
  return jobs.filter((job) => job.status === 'pending' && (job.dependsOn || []).every((dep) => completed.has(dep)));
}
function appendRepairCycle(mission, jobs, reviewJob) {
  const cycle = Number(mission.repairCycles || 0) + 1;
  if (cycle > MAX_REPAIR_CYCLES) return false;
  const stamp = `${cycle}-${Date.now().toString(36)}`;
  const repair = {
    id: `auto-repair-${stamp}`,
    title: `Autonomous repair cycle ${cycle}`,
    objective: `Repair every actionable issue in the latest independent review. Review evidence: ${String(reviewJob?.output?.summary || '').slice(0, 7000)}`,
    kind: 'integration', worker: 'coding', modelRole: 'code_build', dependsOn: [reviewJob.id],
    acceptance: ['Address every actionable reviewer finding', 'Run executable validation', 'Do not hide unresolved failures'],
    status: 'pending', attempts: 0, output: null, evidence: [],
  };
  const verify = {
    id: `auto-review-${stamp}`,
    title: `Independent verification cycle ${cycle}`,
    objective: 'Independently re-check the repaired implementation against the original mission and all prior review findings.',
    kind: 'critic', worker: 'review', modelRole: 'code_review', dependsOn: [repair.id],
    acceptance: ['Verify original acceptance criteria', 'Verify prior findings are actually fixed', 'Return an explicit verdict'],
    status: 'pending', attempts: 0, output: null, evidence: [],
  };
  jobs.push(repair, verify);
  store.saveJobs(mission.id, jobs);
  const agents = store.agents(mission.id);
  agents.push(factory.create(repair, mission), factory.create(verify, mission));
  store.saveAgents(mission.id, agents);
  store.checkpoint(mission.id, { repairCycles: cycle, status: 'running', phase: 'repair' });
  store.event(mission.id, 'repair_cycle_created', { cycle, reviewJobId: reviewJob.id, repairJobId: repair.id, reviewJob: verify.id });
  emit('forge_repair_cycle_created', { missionId: mission.id, cycle, repairJobId: repair.id });
  return true;
}
async function execute(missionId) {
  if (active.has(missionId)) return active.get(missionId);
  const promise = (async () => {
    let mission = store.load(missionId);
    if (!mission) throw new Error(`Mission ${missionId} was not found.`);
    let jobs = store.jobs(missionId);
    for (const job of jobs) if (job.status === 'running') job.status = 'pending';
    store.saveJobs(missionId, jobs);
    mission = updateProgress(missionId, jobs, { status: 'running', phase: 'execute', error: null });
    emit('forge_mission_started', { missionId, objective: mission.objective, jobs: jobs.length });

    let idleRounds = 0;
    while (true) {
      mission = store.load(missionId);
      jobs = store.jobs(missionId);
      const paused = jobs.filter((job) => job.status === 'paused');
      if (paused.length) {
        mission = updateProgress(missionId, jobs, { status: 'paused_inference', phase: 'checkpoint', error: paused[0].error || null });
        store.event(missionId, 'mission_paused', { reason: 'free-inference-unavailable', jobs: paused.map((job) => job.id) });
        return mission;
      }
      const blockedApproval = jobs.filter((job) => job.status === 'blocked_approval');
      if (blockedApproval.length) {
        mission = updateProgress(missionId, jobs, { status: 'awaiting_approval', phase: 'approval' });
        return mission;
      }
      const pending = jobs.filter((job) => job.status === 'pending');
      if (pending.length) {
        const ready = readyJobs(jobs);
        if (!ready.length) {
          idleRounds += 1;
          const hardFailed = new Set(jobs.filter((job) => job.status === 'failed').map((job) => job.id));
          const impossible = pending.filter((job) => (job.dependsOn || []).some((dep) => hardFailed.has(dep)));
          if (impossible.length || idleRounds > 1) {
            for (const job of impossible.length ? impossible : pending) saveJob(missionId, jobs, job, { status: 'blocked', blockedReason: 'dependency-not-satisfied' });
            break;
          }
        } else {
          idleRounds = 0;
          // v1 keeps workspace-writing agents sequential. This protects one shared tree and free API quota.
          await runJob(mission, jobs, ready[0]);
        }
        continue;
      }

      const finalReviews = jobs.filter((job) => job.status === 'completed' && ['critic', 'qa', 'security'].includes(String(job.kind || '').toLowerCase()));
      const lastReview = finalReviews[finalReviews.length - 1];
      const verdict = String(lastReview?.output?.verdict || 'PASS').toUpperCase();
      if (lastReview && ['NEEDS_FIXES', 'BLOCKED', 'UNRESOLVED'].includes(verdict) && appendRepairCycle(mission, jobs, lastReview)) {
        continue;
      }
      break;
    }

    jobs = store.jobs(missionId);
    mission = store.load(missionId);
    const failed = jobs.filter((job) => ['failed', 'blocked'].includes(job.status));
    const completed = jobs.filter((job) => job.status === 'completed');
    const reviews = jobs.filter((job) => job.status === 'completed' && ['critic', 'qa', 'security'].includes(String(job.kind || '').toLowerCase()));
    const lastVerdict = String(reviews[reviews.length - 1]?.output?.verdict || 'PASS').toUpperCase();
    const unresolvedReview = ['NEEDS_FIXES', 'BLOCKED', 'UNRESOLVED'].includes(lastVerdict);
    const status = !failed.length && !unresolvedReview && completed.length === jobs.length ? 'completed' : 'partial';
    mission = updateProgress(missionId, jobs, { status, phase: 'done', completedAt: status === 'completed' ? new Date().toISOString() : null });
    store.event(missionId, 'mission_finished', { status, completed: completed.length, failed: failed.length, lastVerdict, repairCycles: mission.repairCycles || 0 });
    emit('forge_mission_finished', { missionId, status, progress: mission.progress });
    return mission;
  })().finally(() => active.delete(missionId));
  active.set(missionId, promise);
  return promise;
}
async function createMission(objective, options = {}) {
  const mission = store.create(objective, options);
  initWorkspace(mission.workspace);
  let automationSpec = null;
  if (automation.isAutomationObjective(objective)) {
    automationSpec = automation.create(objective);
    fs.writeFileSync(path.join(mission.workspace, 'automation.manifest.json'), JSON.stringify(automationSpec, null, 2), 'utf8');
  }
  store.checkpoint(mission.id, { status: 'compiling', phase: 'compile', automation: automationSpec });
  const compiled = await compiler.compile({ ...mission, automation: automationSpec });
  const jobs = compiled.jobs;
  const agents = factory.staff(jobs, mission);
  store.saveJobs(mission.id, jobs);
  store.saveAgents(mission.id, agents);
  store.checkpoint(mission.id, {
    status: 'ready', phase: 'execute', summary: compiled.summary,
    requirements: compiled.requirements, deliverables: compiled.deliverables, risks: compiled.risks,
    automation: automationSpec, compiler: compiled.compiler, compilerModel: compiled.model || null,
    compilerError: compiled.compilerError || null, repairCycles: 0,
    progress: { total: jobs.length, completed: 0, failed: 0, running: 0, blocked: 0, paused: 0, percent: 0 },
  });
  store.event(mission.id, 'mission_compiled', { jobs: jobs.length, agents: agents.length, compiler: compiled.compiler, automation: Boolean(automationSpec) });
  return store.load(mission.id);
}
async function start(objective, options = {}) {
  const mission = await createMission(objective, options);
  setImmediate(() => execute(mission.id).catch((error) => {
    try { store.checkpoint(mission.id, { status: 'failed', phase: 'error', error: error.message }); } catch {}
    emit('forge_mission_failed', { missionId: mission.id, error: error.message });
  }));
  return mission;
}
function status(missionId = null) {
  const mission = missionId ? store.load(missionId) : store.list(1)[0];
  if (!mission) return { available: false, message: 'No Forge mission exists yet.' };
  return { available: true, mission, jobs: store.jobs(mission.id), agents: store.agents(mission.id), usage: store.usage(mission.id), running: active.has(mission.id) };
}
function approve(missionId = null) {
  const mission = missionId ? store.load(missionId) : store.list(1)[0];
  if (!mission) throw new Error('No Forge mission is available for approval.');
  const jobs = store.jobs(mission.id);
  const blocked = jobs.filter((job) => job.status === 'blocked_approval');
  for (const job of blocked) { job.status = 'pending'; job.approvedAt = new Date().toISOString(); job.blockedReason = null; }
  store.saveJobs(mission.id, jobs);
  store.event(mission.id, 'approval_granted', { jobs: blocked.map((job) => job.id) });
  if (blocked.length) setImmediate(() => execute(mission.id).catch(() => {}));
  return { missionId: mission.id, approvedJobs: blocked.map((job) => job.id) };
}
function resume(missionId = null) {
  const mission = missionId ? store.load(missionId) : store.list(1)[0];
  if (!mission) throw new Error('No Forge mission is available to resume.');
  const jobs = store.jobs(mission.id);
  const paused = jobs.filter((job) => job.status === 'paused');
  for (const job of paused) { job.status = 'pending'; job.error = null; job.pausedReason = null; }
  store.saveJobs(mission.id, jobs);
  store.checkpoint(mission.id, { status: 'ready', phase: 'execute', error: null });
  store.event(mission.id, 'mission_resumed', { jobs: paused.map((job) => job.id) });
  setImmediate(() => execute(mission.id).catch(() => {}));
  return { missionId: mission.id, resumedJobs: paused.map((job) => job.id) };
}
function recover() {
  const candidates = store.list(30).filter((mission) => ['running', 'compiling', 'ready'].includes(mission.status));
  for (const mission of candidates) setImmediate(() => execute(mission.id).catch(() => {}));
  return candidates.map((mission) => mission.id);
}

module.exports = { shouldUse, isStatusRequest, isApprovalRequest, isResumeRequest, externalSideEffect, inferenceResourceError, createMission, start, execute, status, approve, resume, recover, readyJobs, appendRepairCycle };
