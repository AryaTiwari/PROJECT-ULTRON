function analyze(request = {}, guardian = {}) {
  const text = String(request.message || '').trim();
  const concerns = [];
  const suggestions = [];

  if (!text) {
    return { status: 'reject', concerns: ['No user request supplied.'], suggestions: [] };
  }

  if (guardian.level >= 3) {
    concerns.push(...guardian.reasons);
    suggestions.push('Use a reversible, sandboxed, or read-only approach first.');
  }

  if (/\binstall\b/i.test(text) && /\bgithub|repository|repo\b/i.test(text)) {
    concerns.push('External repository installation may introduce unreviewed dependencies.');
    suggestions.push('Inspect the repository and dependencies before executing installation scripts.');
  }

  if (/\bdelete|wipe|destroy|format\b/i.test(text)) {
    concerns.push('The requested operation may be difficult to reverse.');
    suggestions.push('Create a backup or reversible archive before destructive execution.');
  }

  return {
    status: concerns.length ? 'review' : 'approved',
    concerns,
    suggestions,
  };
}

module.exports = { analyze };
