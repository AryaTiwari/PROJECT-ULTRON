function extractCommitment(message) {
  const text = String(message || '').trim();
  const patterns = [
    /^(?:i\s+(?:will|am going to)|i'll)\s+(.{3,180})$/i,
    /^(?:remind me to|remember that i need to)\s+(.{3,180})$/i,
    /^(?:i\s+need to|i\s+must)\s+(.{3,180})$/i,
  ];
  for (const regex of patterns) {
    const match = regex.exec(text);
    if (match) return { title: match[1].replace(/[.!?]+$/, '').trim(), priority: /urgent|important|critical|today/i.test(match[1]) ? 'high' : 'medium' };
  }
  return null;
}

function extractProject(message) {
  const match = String(message || '').match(/\b(?:for|on|in)\s+(Elevate(?: OS)?|ULTRON|BSc Physics|Physics)\b/i);
  return match ? match[1] : null;
}
module.exports = { extractCommitment, extractProject };
