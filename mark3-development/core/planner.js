const { emit } = require('./events');

function inferPlan(message) {
  const text = String(message || '').trim();
  const steps = [];
  if (/github|repository|repo|file/i.test(text)) steps.push('Inspect repository state', 'Execute requested repository operation', 'Verify the resulting state');
  else if (/research|compare|find|look up|latest/i.test(text)) steps.push('Clarify the objective', 'Collect evidence', 'Synthesize findings', 'State uncertainty');
  else if (/remind|tomorrow|deadline|later|commit/i.test(text)) steps.push('Create or update commitment', 'Set timing and priority', 'Confirm the next action');
  else steps.push('Understand objective', 'Select best available model and tools', 'Execute', 'Verify', 'Respond with next action');
  return { objective: text, steps };
}

function createPlan(message, taskType = 'general') {
  const plan = { id: `plan-${Date.now()}`, taskType, ...inferPlan(message), createdAt: new Date().toISOString() };
  emit('plan_created', { plan });
  return plan;
}

module.exports = { inferPlan, createPlan };
