const fs = require('fs');
const path = require('path');
const compiler = require('../core/forge/mission-compiler');
const factory = require('../core/forge/agent-factory');
const governor = require('../core/forge/model-governor');
const supervisor = require('../core/forge/supervisor');
const store = require('../core/forge/mission-store');
const codingInference = require('../core/coding-inference');

function assert(condition, message) { if (!condition) throw new Error(message); }

const plan = compiler.fallback('Build a complete automated creator CRM with a dashboard and workflows');
assert(plan.jobs.length >= 6, 'Forge fallback must produce a multi-step mission DAG.');
assert(plan.jobs.some((job) => job.worker === 'coding'), 'Forge mission must contain a coding worker.');
assert(plan.jobs.some((job) => job.worker === 'review'), 'Forge mission must contain an independent review worker.');
assert(supervisor.shouldUse('Ultron, build me a complete automated CRM system'), 'Large build requests must route to Forge.');
assert(!supervisor.shouldUse('What is a CRM?'), 'Ordinary questions must not route to Forge.');
assert(supervisor.externalSideEffect('deploy to production'), 'Production deployment must be approval-gated.');

const fakeMission = { id: 'selftest-mission', objective: 'test', workspace: 'test' };
const agents = factory.staff(plan.jobs, fakeMission);
assert(agents.length === plan.jobs.length, 'Every Forge job must receive an agent.');
assert(agents.some((agent) => agent.worker === 'coding'), 'Agent factory must create coding specialists.');
assert(agents.some((agent) => agent.worker === 'review'), 'Agent factory must create reviewers.');

const modelStatus = governor.status();
assert(modelStatus.zeroCostOnly === true, 'Forge must enforce zero-cost inference mode.');
assert(modelStatus.localLlmAllowed === false, 'Forge must not allow local LLM inference.');
assert(modelStatus.paidFallbackAllowed === false, 'Forge must not allow paid fallback.');
assert(modelStatus.roleModels.code_build[0] === 'poolside/laguna-xs-2.1', 'Laguna XS 2.1 must be the primary coding specialist.');
assert(codingInference.forgeRole('editor') === 'code_build', 'Coding Brain editor must route through the Forge code-build role.');
assert(codingInference.forgeRole('reviewer') === 'code_review', 'Coding Brain reviewer must route through the Forge code-review role.');
assert(codingInference.allowGeneralFallback() === false, 'General-purpose coding fallback must be disabled by default.');

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
} finally {
  try { fs.rmSync(missionDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(path.join(store.WORKSPACES, mission.id), { recursive: true, force: true }); } catch {}
}

console.log('ULTRON Forge self-test passed: persistent missions, DAG decomposition, dynamic agents, approval gates, zero-cost model policy, Laguna Coding Brain route and no-general-fallback policy validated.');
