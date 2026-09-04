const fs = require('fs');
const path = require('path');
const config = require('../core/config');
const workspace = require('../core/workspace');
const memory = require('../core/memory');
const intent = require('../core/intent');
const planner = require('../core/planner');
const verifier = require('../core/verifier');
const proactive = require('../core/proactive');
const modelLeague = require('../core/model-league');

function assert(condition, message) { if (!condition) throw new Error(message); }

const files = [
  config.memoryPath,
  config.commitmentsPath,
  config.decisionsPath,
  config.projectsPath,
  path.join(config.dataDir, 'tasks.json'),
  path.join(config.dataDir, 'goals.json'),
  path.join(config.dataDir, 'executions.json'),
];
const backups = new Map(files.map((file) => [file, fs.existsSync(file) ? fs.readFileSync(file) : null]));

try {
  fs.mkdirSync(config.dataDir, { recursive: true });
  for (const file of files) fs.writeFileSync(file, '[]', 'utf8');

  const taskMutation = intent.extractWorkspaceMutation('I need to finish Instagram integration for Elevate OS tomorrow');
  assert(taskMutation?.type === 'create_task', 'Need-to language must create a task.');
  assert(taskMutation.project === 'Elevate OS', 'Task project extraction failed.');
  assert(Boolean(taskMutation.dueAt), 'Tomorrow deadline was not captured.');
  const voiceTaskMutation = intent.extractWorkspaceMutation('Hello Ultron, I need to finish Instagram integration for Elevate OS tomorrow');
  assert(voiceTaskMutation?.type === 'create_task', 'Voice-prefixed need-to language must create a task.');
  assert(voiceTaskMutation.project === 'Elevate OS' && Boolean(voiceTaskMutation.dueAt), 'Voice-prefixed task must preserve project and deadline extraction.');
  workspace.applyMutation(taskMutation);
  workspace.applyMutation(taskMutation);
  assert(workspace.listTasks().length === 1, 'Repeated task capture must be idempotent.');

  const goalMutation = intent.extractWorkspaceMutation('Goal: ship a reliable advisor executor and butler this week');
  assert(goalMutation?.type === 'create_goal', 'Explicit goal language must create a goal.');
  workspace.applyMutation(goalMutation);
  assert(workspace.listGoals().length === 1, 'Goal was not persisted.');

  const commitmentMutation = intent.extractWorkspaceMutation("I'll review the reliability results tomorrow");
  assert(commitmentMutation?.type === 'create_commitment', 'Will-language must create a commitment.');
  const curlyCommitmentMutation = intent.extractWorkspaceMutation('I’ll review the reliability results tomorrow');
  assert(curlyCommitmentMutation?.type === 'create_commitment', 'Curly-apostrophe will-language must create a commitment.');
  workspace.applyMutation(commitmentMutation);
  assert(workspace.listCommitments().length === 1, 'Commitment was not persisted.');

  const completed = workspace.applyMutation({ type: 'complete', query: 'Instagram integration', project: 'Elevate OS' });
  assert(completed?.match?.kind === 'task', 'Completion should resolve the matching task.');
  assert(workspace.listTasks()[0].status === 'completed', 'Matching task was not closed.');

  const firstMemory = memory.remember({ type: 'project', key: 'elevate:instagram:status', entity: 'Elevate OS', relation: 'Instagram integration', content: 'Instagram integration is pending.' });
  const updatedMemory = memory.remember({ type: 'project', key: 'elevate:instagram:status', entity: 'Elevate OS', relation: 'Instagram integration', content: 'Instagram integration is working.' });
  assert(firstMemory.action === 'SAVED' && updatedMemory.action === 'UPDATED', 'Keyed memory must update contradictory/current state instead of duplicating it.');
  assert(memory.load().filter((item) => item.key === 'elevate instagram status').length === 1, 'Keyed memory update created a duplicate.');

  const plan = planner.createPlan('Fix the renderer in the repository and verify it', 'coding');
  assert(plan.kind === 'repository_action' && plan.verification.length >= 2, 'Planner must produce execution-specific verification criteria.');

  const execution = workspace.recordExecution({ objective: plan.objective, taskType: 'coding', planId: plan.id });
  const verified = verifier.verifyExecution({ kind: 'repository_action', changedFiles: 2, validation: 'PASS', evidence: ['commit verified'] });
  assert(verified.ok && verified.status === 'verified', 'Repository execution with change+validation evidence must verify.');
  workspace.updateExecution(execution.id, { status: verified.status, verification: verified });
  assert(workspace.listExecutions(1)[0].status === 'verified', 'Verified execution status was not persisted.');

  const overdue = workspace.createTask({ title: 'Critical overdue test', priority: 'critical', dueAt: new Date(Date.now() - 3600000).toISOString() });
  assert(proactive.scoreItem(overdue, 'task') >= 80, 'Critical overdue work must reach interrupt-level attention.');
  assert(proactive.attentionLevel(proactive.scoreItem(overdue, 'task')) === 'critical', 'Attention classification failed.');

  const todayTask = workspace.createTask({ title: 'Today reliability task', priority: 'high', dueAt: intent.dueAtFromText('today') });
  const naturalStateQuestion = 'Hello Ultron, what is the pending task for today?';
  assert(intent.isStateBriefRequest(naturalStateQuestion), 'Natural today-task question must route to local workspace state.');
  const localStateAnswer = proactive.stateResponse(naturalStateQuestion);
  assert(localStateAnswer.includes(todayTask.title), 'Today-task state answer must name the locally persisted due-today task.');
  assert(!/TinyFish|calendar|task manager/i.test(localStateAnswer), 'Local state answers must not claim web research or redirect to an external task manager.');

  const advisorQuestion = 'So what should we start today? Like what should we do?';
  assert(intent.isStateBriefRequest(advisorQuestion), 'Natural today advisor question must route to local workspace state.');
  const advisorAnswer = proactive.stateResponse(advisorQuestion);
  assert(!/TinyFish|Checked:|search the web/i.test(advisorAnswer), 'Today advisor answer must remain local unless external research is explicitly requested.');

  proactive.syncStateMemory();
  const stateMemory = memory.retrieve('what are my work priorities and what is next', { limit: 4 });
  assert(stateMemory.some((item) => item.key === 'ultron workspace current state'), 'Live workspace state must be retrievable for priority/status questions.');

  const previousLeagueFlag = process.env.ULTRON_M3_LEAGUE_ENABLED;
  process.env.ULTRON_M3_LEAGUE_ENABLED = '0';
  proactive.start(60 * 60 * 1000);
  assert(modelLeague.recommend('general').primary === null, 'Model League must be diagnostic-only unless explicitly enabled.');
  proactive.stop();
  if (previousLeagueFlag == null) delete process.env.ULTRON_M3_LEAGUE_ENABLED; else process.env.ULTRON_M3_LEAGUE_ENABLED = previousLeagueFlag;

  const snapshot = workspace.stateSnapshot();
  assert(snapshot.counts.goals === 1 && snapshot.counts.tasks >= 1, 'Workspace state snapshot is incomplete.');
  console.log('ULTRON reliability self-test passed: entity-aware memory updates, voice-prefixed task capture, idempotent tasks/goals/commitments, local-first today status/advice, completion resolution, execution verification, proactive attention and diagnostic-only Model League validated.');
} finally {
  try { proactive.stop(); } catch {}
  for (const [file, backup] of backups.entries()) {
    if (backup == null) { try { fs.unlinkSync(file); } catch {} }
    else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, backup); }
  }
}
