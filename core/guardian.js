const HARD_BLOCK_TERMS = [
  'steal password',
  'steal credentials',
  'deploy malware',
  'ransomware',
  'destroy system files',
];

const HIGH_RISK_PATTERNS = [
  /delete\s+(all|every)\s+files?/i,
  /format\s+(the\s+)?drive/i,
  /disable\s+(windows\s+)?defender/i,
  /disable\s+(the\s+)?firewall/i,
  /exfiltrat/i,
  /dump\s+password/i,
  /send\s+secret/i,
];

function assess({ message = '', action = null } = {}) {
  const text = String(message).trim();
  const reasons = [];
  const lower = text.toLowerCase();

  if (HARD_BLOCK_TERMS.some(term => lower.includes(term))) {
    return { level: 3, decision: 'block', reasons: ['Request matches a prohibited high-risk pattern.'] };
  }

  if (HIGH_RISK_PATTERNS.some(pattern => pattern.test(text)) || action?.destructive) {
    reasons.push('Potentially destructive or security-sensitive action.');
  }
  if (action?.requiresConfirmation) reasons.push('Tool policy requires confirmation.');

  if (reasons.length) {
    return { level: 2, decision: 'warn', reasons };
  }
  return { level: 0, decision: 'proceed', reasons: [] };
}

module.exports = { assess };
