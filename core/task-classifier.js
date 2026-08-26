const RULES = [
  ['coding', /\b(code|coding|debug|bug|repository|github|javascript|python|typescript|sql|program)\b/i],
  ['research', /\b(research|compare|investigate|latest|sources|papers|study)\b/i],
  ['automation', /\b(automate|schedule|send|create|delete|open|close|install|run|execute)\b/i],
  ['planning', /\b(plan|roadmap|strategy|architecture|design)\b/i],
  ['creative', /\b(write|draft|story|caption|post|creative|brainstorm)\b/i],
  ['simple_qa', /\b(what|who|when|where|why|how)\b/i],
];

function classify(message = '') {
  const text = String(message).trim();
  for (const [type, pattern] of RULES) {
    if (pattern.test(text)) return { taskType: type, confidence: 0.65 };
  }
  return { taskType: 'general', confidence: 0.5 };
}

module.exports = { classify };
