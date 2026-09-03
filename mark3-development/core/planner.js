const crypto = require('crypto');
const { emit } = require('./events');

function classify(message, taskType = 'general') {
  const text = String(message || '').toLowerCase();
  if (/\b(?:edit|update|create|delete|fix|implement|patch|deploy|commit|push)\b/.test(text) && /\b(?:repo|repository|github|file|code|ultron|elevate)\b/.test(text)) return 'repository_action';
  if (/\b(?:research|compare|find|look up|latest|verify online|search)\b/.test(text) || taskType === 'research') return 'research';
  if (/\b(?:remind|todo|task|deadline|goal|need to|must|will)\b/.test(text)) return 'state_change';
  if (/\b(?:create|generate|make|export)\b/.test(text) && /\b(?:pdf|docx|document|image|video|file)\b/.test(text)) return 'artifact';
  return 'advice';
}

function inferPlan(message, taskType = 'general') {
  const text = String(message || '').trim();
  const kind = classify(text, taskType);
  if (kind === 'repository_action') return {
    kind,
    steps: ['Inspect the exact target state', 'Apply the smallest safe change', 'Run or obtain validation evidence', 'Report changed state and remaining risk'],
    verification: ['Requested change exists in the target', 'Validation/test evidence is positive', 'No unrelated working subsystem was modified'],
  };
  if (kind === 'research') return {
    kind,
    steps: ['Define the decision or question', 'Collect current evidence', 'Cross-check important claims', 'Synthesize the answer'],
    verification: ['Evidence was actually retrieved', 'Claims are supported by retrieved evidence', 'Uncertainty is stated where evidence is incomplete'],
  };
  if (kind === 'state_change') return {
    kind,
    steps: ['Identify the goal/task/commitment', 'Update persistent state idempotently', 'Choose priority/deadline when explicit', 'Confirm the next actionable state'],
    verification: ['Persistent state reflects the request', 'Duplicate active items were not created'],
  };
  if (kind === 'artifact') return {
    kind,
    steps: ['Compose requested content', 'Render the requested artifact', 'Persist the file', 'Expose a real downloadable artifact'],
    verification: ['Artifact file exists', 'Artifact has non-zero content', 'Download reference points to the persisted artifact'],
  };
  return {
    kind,
    steps: ['Understand the objective', 'Use relevant state and memory', 'Give the clearest recommendation or answer'],
    verification: ['Response directly addresses the objective', 'No action is claimed as completed without evidence'],
  };
}

function createPlan(message, taskType = 'general') {
  const inferred = inferPlan(message, taskType);
  const plan = { id: crypto.randomUUID(), taskType, objective: String(message || '').trim(), ...inferred, createdAt: new Date().toISOString() };
  emit('plan_created', { plan });
  return plan;
}

module.exports = { classify, inferPlan, createPlan };
