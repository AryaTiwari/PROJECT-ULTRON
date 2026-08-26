const BLOCKED_ACTIONS = new Set([
  'credential_exfiltration',
  'security_bypass',
  'destructive_system_action',
]);

function assess(request = {}) {
  const text = String(request.message || '').trim();
  const requestedAction = request.action || null;
  const reasons = [];

  if (!text) {
    return { level: 0, decision: 'block', reasons: ['Empty request.'] };
  }

  if (requestedAction && BLOCKED_ACTIONS.has(requestedAction)) {
    return {
      level: 4,
      decision: 'block',
      reasons: [`Action '${requestedAction}' is not permitted.`],
    };
  }

  // Mark 2 intentionally starts flexible: risky intent is surfaced, not
  // automatically rejected, unless it crosses an explicit hard boundary.
  const destructive = /\b(delete|erase|format|wipe|destroy)\b/i.test(text);
  const privileged = /\b(admin|administrator|elevat|sudo|firewall|registry)\b/i.test(text);
  const external = /\b(send|publish|post|email|message|purchase|pay)\b/i.test(text);

  if (destructive) reasons.push('Potentially destructive operation.');
  if (privileged) reasons.push('May require elevated system privileges.');
  if (external) reasons.push('May create an external side effect.');

  const level = reasons.length >= 2 ? 3 : reasons.length === 1 ? 2 : 0;
  const decision = level >= 3 ? 'approval_required' : 'proceed';

  return { level, decision, reasons };
}

module.exports = { assess };
