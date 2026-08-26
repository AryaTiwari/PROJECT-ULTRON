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
  ].filter(Boolean).join('\n');
}

module.exports = { loadPersonality, buildSystemPrompt };
