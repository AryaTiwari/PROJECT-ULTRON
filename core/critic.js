function analyze({ message = '', plannedAction = null } = {}, guardian = { decision: 'proceed' }) {
  const concerns = [];
  const suggestions = [];

  if (guardian.decision === 'block') {
    concerns.push('Guardian has blocked the request.');
    return { status: 'blocked', concerns, suggestions };
  }

  if (plannedAction?.destructive) {
    concerns.push('Action is destructive or difficult to reverse.');
    suggestions.push('Prefer a reversible operation, backup, or dry run first.');
  }

  if (plannedAction?.externalSideEffect) {
    concerns.push('Action creates an external side effect.');
    suggestions.push('Verify target, scope, and final payload before execution.');
  }

  if (String(message).trim().length > 20000) {
    concerns.push('Input is unusually large and should be handled in chunks.');
    suggestions.push('Summarize or split the request before execution.');
  }

  return {
    status: concerns.length ? 'review' : 'approved',
    concerns,
    suggestions,
  };
}

module.exports = { analyze };
