const SECRET_NAME = '(?:api[_-]?key|token|secret|password|passwd|client[_-]?secret|access[_-]?key|private[_-]?key|authorization)';

function redactText(input) {
  let text = String(input || '');

  // Authorization headers must be handled before generic key/value rules. Otherwise a
  // generic rule can redact only the word "Bearer" and accidentally leave the token.
  text = text.replace(/\b(Authorization\s*:\s*)(Bearer|Basic)\s+[^\s,;]+/gi, '$1$2 [REDACTED]');
  text = text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=:-]{8,}/gi, '$1 [REDACTED]');

  // .env / config assignments: preserve the variable name, redact only the value.
  text = text.replace(new RegExp(`(^|\\n)(\\s*[A-Z0-9_]*${SECRET_NAME}[A-Z0-9_]*\\s*=\\s*)([^\\r\\n]+)`, 'gi'), (_, lead, name) => `${lead}${name}[REDACTED]`);

  // JSON/YAML-like secret fields. Redact the complete scalar value rather than just
  // its first whitespace-delimited token.
  text = text.replace(
    new RegExp(`(["']?[A-Za-z0-9_.-]*${SECRET_NAME}[A-Za-z0-9_.-]*["']?\\s*[:=]\\s*)(["'])(.*?)\\2`, 'gi'),
    '$1$2[REDACTED]$2',
  );
  text = text.replace(
    new RegExp(`(["']?[A-Za-z0-9_.-]*${SECRET_NAME}[A-Za-z0-9_.-]*["']?\\s*[:=]\\s*)([^\\r\\n,}]+)`, 'gi'),
    '$1[REDACTED]',
  );

  // Common provider key shapes and long opaque secrets.
  text = text.replace(/\b(?:sk|nvapi|gsk|AIza|ghp|github_pat)[-_A-Za-z0-9]{12,}\b/g, '[REDACTED]');
  return text;
}
function redactMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((row) => ({ ...row, content: redactText(row?.content) }));
}

module.exports = { redactText, redactMessages };
