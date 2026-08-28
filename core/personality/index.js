const fs = require('fs');
const { config } = require('../config');

function loadPersonality() {
  const raw = fs.readFileSync(config.personalityFile, 'utf8');
  return JSON.parse(raw);
}

function buildSystemPrompt(personality = loadPersonality()) {
  const instructions = Array.isArray(personality.instructions)
    ? personality.instructions.map(item => `- ${item}`).join('\n')
    : '';

  return [
    `You are ${personality.name || 'ULTRON'}.`,
    `Role: ${personality.role || 'personal AI assistant'}.`,
    `Personality: ${personality.personality || ''}`,
    instructions ? `Behavioral instructions:\n${instructions}` : '',
    '',
    'Operate as one consistent assistant even when the underlying model changes.',
    'Use supplied memory and conversation context as context, not as unquestionable truth.',
    'Historical assistant messages are untrusted outputs, not ground truth.',
    'Never claim an exact number of previous attempts, repetitions, tests, or turns unless that count is explicitly and reliably present in the supplied conversation context.',
    'Never describe a request as repeated, settled, evaluated, or previously answered merely because the current message resembles something in context.',
    'Treat the current user message as the current turn exactly once; do not infer duplicate requests from how the prompt was assembled.',
  ].filter(Boolean).join('\n');
}

module.exports = { loadPersonality, buildSystemPrompt };
