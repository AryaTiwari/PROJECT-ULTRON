const SECRET_NAME = '(?:api[_-]?key|token|secret|password|passwd|client[_-]?secret|access[_-]?key|private[_-]?key|authorization)';

function redactText(input) {
  let text = String(input || '');
  // .env / config assignments: preserve the variable name, redact only the value.
  text = text.replace(new RegExp(`(^|\\n)(\\s*[A-Z0-9_]*${SECRET_NAME}[A-Z0-9_]*\\s*=\\s*)([^\\r\\n]+)`, 'gi'), (_, lead, name) => `${lead}${name}[REDACTED]`);
  // JSON/YAML-like secret fields.
  text = text.replace(new RegExp(`(["']?[A-Za-z0-9_.-]*${SECRET_NAME}[A-Za-z0-9_.-]*["']?\\s*[:=]\\s*["']?)([^"'\\s,}]{6,})`, 'gi'), '$1[REDACTED]');
  // Authorization bearer/basic payloads.
  text = text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=:-]{8,}/gi, '$1 [REDACTED]');
  // Common provider key shapes and long opaque secrets.
  text = text.replace(/\b(?:sk|nvapi|gsk|AIza|ghp|github_pat)[-_A-Za-z0-9]{12,}\b/g, '[REDACTED]');
  return text;
}
function redactMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((row) => ({ ...row, content: redactText(row?.content) }));
}

module.exports = { redactText, redactMessages };
