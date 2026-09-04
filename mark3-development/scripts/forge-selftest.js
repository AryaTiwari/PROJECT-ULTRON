const fs = require('fs');
const path = require('path');
const compiler = require('../core/forge/mission-compiler');
const factory = require('../core/forge/agent-factory');
const governor = require('../core/forge/model-governor');
const supervisor = require('../core/forge/supervisor');
const store = require('../core/forge/mission-store');
const automation = require('../core/forge/automation-blueprint');
const goose = require('../core/forge/goose-worker');
const codingInference = require('../core/coding-inference');
const redactor = require('../core/forge/redactor');

function assert(condition, message) { if (!condition) throw new Error(message); }

const objective = 'Build a complete automated creator CRM with a dashboard and workflows';
const plan = compiler.fallback(objective);
assert(plan.jobs.length >= 6, 'Forge fallback must produce a multi-step mission DAG.');
assert(plan.jobs.some((job) => job.worker === 'coding'), 'Forge mission must contain a coding worker.');
assert(plan.jobs.some((job) => job.worker === 'review'), 'Forge mission must contain an independent review worker.');
assert(plan.jobs.some((job) => !(job.dependsOn || []).length), 'Forge mission must always contain at least one runnable root job.');

const cyclicPlan = compiler.validateGraph({
  jobs: [
    { id: 'a', title: 'A', objective: 'A', kind: 'architect', worker: 'reasoning', dependsOn: ['c'] },
    { id: 'b', title: 'B', objective: 'B', kind: 'backend', worker: 'coding', dependsOn: ['a'] },
    { id: 'c', title: 'C', objective: 'C', kind: 'qa', worker: 'review', dependsOn: ['b'] },
  ],
}, 'cycle regression');
assert(cyclicPlan.jobs.some((job) => !(job.dependsOn || []).length), 'Forge validator must repair a graph with no runnable root.');
let cyclePending = new Set(cyclicPlan.jobs.map((job) => job.id));
const cycleResolved = new Set();
while (cyclePending.size) {
  const runnable = cyclicPlan.jobs.filter((job) => cyclePending.has(job.id) && (job.dependsOn || []).every((dep) => cycleResolved.has(dep)));
  assert(runnable.length > 0, 'Forge validator must break dependency cycles instead of persisting a deadlocked mission.');
  for (const job of runnable) { cyclePending.delete(job.id); cycleResolved.add(job.id); }
}
assert(cycleResolved.size === cyclicPlan.jobs.length, 'Every repaired Forge job must be topologically executable.');

assert(supervisor.shouldUse('Ultron, build me a complete automated CRM system'), 'Large build requests must route to Forge.');
assert(!supervisor.shouldUse('What is a CRM?'), 'Ordinary questions must not route to Forge.');
assert(supervisor.externalSideEffect('deploy to production'), 'Production deployment must be approval-gated.');
assert(supervisor.isApprovalRequest('Approve Forge') === true, 'Natural Forge approval must target the latest mission.');

const naturalAutomation = 'Whenever a lead submits a form, qualify it, store it in Supabase and prepare outreach';
const automationSpec = automation.create(naturalAutomation);
assert(automation.isAutomationObjective(automationSpec.objective), 'Automation objectives must be detected.');
assert(automation.triggerFrom(naturalAutomation) === 'webhook', 'Natural form-submission automation must classify as a webhook trigger.');
assert(!automation.isAutomationObjective('When is the next meeting?'), 'Ordinary when-questions must not be misclassified as automations.');
assert(automationSpec.delivery.executableProgram === true && automationSpec.delivery.restartSafe === true, 'Automation missions must require executable restart-safe programs.');
assert(automationSpec.contracts.idempotencyKey === true && automationSpec.contracts.persistentCheckpoint === true, 'Automation missions must require idempotency and checkpoints.');
assert(automationSpec.contracts.externalSideEffectsApproval === true, 'Automation missions must gate external side effects.');
assert(/actual executable automation program/i.test(automation.workerInstruction(automationSpec.objective)), 'Coding workers must receive the automation program contract.');

const fakeMission = { id: 'selftest-mission', objective: 'test', workspace: 'test' };
const agents = factory.staff(plan.jobs, fakeMission);
assert(agents.length === plan.jobs.length, 'Every Forge job must receive an agent.');
assert(agents.some((agent) => agent.worker === 'coding'), 'Agent factory must create coding specialists.');
assert(agents.some((agent) => agent.worker === 'review'), 'Agent factory must create reviewers.');

const modelStatus = governor.status();
assert(modelStatus.zeroCostOnly === true, 'Forge must enforce zero-cost inference mode.');
assert(modelStatus.localLlmAllowed === false, 'Forge must not allow local LLM inference.');
assert(modelStatus.paidFallbackAllowed === false, 'Forge must not allow paid fallback.');
assert(modelStatus.secretRedaction === true, 'Forge cloud inference must report secret redaction enabled.');
assert(modelStatus.externalWorkerBudgeting === true, 'External agent harnesses must be budgeted before they can consume free inference.');
assert(modelStatus.asyncPolling === true && modelStatus.pollIntervalMs >= 250, 'Forge must support NVIDIA asynchronous 202 polling.');
assert(modelStatus.roleModels.code_build[0] === 'poolside/laguna-xs-2.1', 'Laguna XS 2.1 must be the primary coding specialist.');
const gooseStatus = goose.status();
assert(gooseStatus.defaultWorker === false, 'Goose must remain optional rather than becoming a hard Forge dependency.');
assert(gooseStatus.separateGooseApiRequired === false && gooseStatus.requiredApi === 'NVIDIA_API_KEY', 'Goose must reuse Forge NVIDIA inference rather than require another paid API.');
assert(gooseStatus.model === 'poolside/laguna-xs-2.1', 'Goose coding worker must target the same specialist coding model by default.');
assert(codingInference.forgeRole('editor') === 'code_build', 'Coding Brain editor must route through the Forge code-build role.');
assert(codingInference.forgeRole('reviewer') === 'code_review', 'Coding Brain reviewer must route through the Forge code-review role.');
assert(codingInference.allowGeneralFallback() === false, 'General-purpose coding fallback must be disabled by default.');
assert(codingInference.missionIdFromMessages([{ role: 'system', content: 'workspace=C:\\Users\\arya\\Project-Ultron\\.ultron\\forge\\workspaces\\20260904-test-ab12' }]) === '20260904-test-ab12', 'Coding Brain must recover the Forge mission id from its isolated workspace for token accounting.');
const redacted = redactor.redactText('NVIDIA_API_KEY=nvapi-super-secret-value\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz');
assert(!redacted.includes('super-secret-value') && !redacted.includes('abcdefghijklmnopqrstuvwxyz'), 'Forge must redact credentials before cloud inference.');
const redactedStructured = redactor.redactText('{"apiKey":"json-super-secret-value","client_secret":"client-secret-value"}\nAuthorization: Basic YmFzZTY0LXNlY3JldC12YWx1ZQ==');
assert(!redactedStructured.includes('json-super-secret-value') && !redactedStructured.includes('client-secret-value') && !redactedStructured.includes('YmFzZTY0LXNlY3JldC12YWx1ZQ=='), 'Forge must redact quoted JSON secrets and Basic authorization credentials.');

const mission = store.create('Forge offline self-test', { source: 'selftest' });
const missionDir = path.join(store.MISSIONS, mission.id);
try {
  store.saveJobs(mission.id, plan.jobs);
  store.saveAgents(mission.id, agents.map((agent) => ({ ...agent, missionId: mission.id })));
  const loaded = store.load(mission.id);
  assert(loaded?.constraints?.zeroCostOnly === true, 'Persisted mission must retain zero-cost constraint.');
  assert(store.jobs(mission.id).length === plan.jobs.length, 'Mission jobs must persist across reads.');
  store.checkpoint(mission.id, { status: 'running', phase: 'execute' });
  assert(store.load(mission.id).status === 'running', 'Mission checkpoints must persist state.');

  const failedReview = {
    id: 'selftest-review', title: 'Self-test critic', objective: 'Review the build', kind: 'critic', worker: 'review',
    dependsOn: [], acceptance: [], status: 'completed', attempts: 1,
    output: { summary: 'A concrete defect remains.', verdict: 'NEEDS_FIXES' }, evidence: [],
  };
  store.saveJobs(mission.id, [failedReview]);
  store.saveAgents(mission.id, [factory.create(failedReview, loaded)]);
  assert(supervisor.appendRepairCycle(store.load(mission.id), store.jobs(mission.id), failedReview) === true, 'Failed independent review must create an autonomous repair cycle.');
  const repairedGraph = store.jobs(mission.id);
  assert(repairedGraph.some((job) => job.id.startsWith('auto-repair-') && job.worker === 'coding'), 'Repair cycle must create a coding repair agent.');
  assert(repairedGraph.some((job) => job.id.startsWith('auto-review-') && job.worker === 'review'), 'Repair cycle must create a fresh independent reviewer.');
} finally {
  try { fs.rmSync(missionDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(path.join(store.WORKSPACES, mission.id), { recursive: true, force: true }); } catch {}
}

console.log('ULTRON Forge self-test passed: persistent missions, runnable acyclic DAG repair, dynamic agents, natural event-driven automation detection, executable automation contracts, approval gates, bounded autonomous repair/re-review, zero-cost NVIDIA specialist routing with async polling, optional budgeted Goose worker, mission token accounting, cloud secret redaction and no-general-fallback policy validated.');
