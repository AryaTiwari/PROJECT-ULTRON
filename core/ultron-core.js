const fs = require('fs');
const path = require('path');
const { assess } = require('./guardian');
const { analyze } = require('./critic');
const { chat } = require('./model-router');
const { normalizeMemoryCandidate, looksLikeDuplicate } = require('./memory');

const PERSONALITY_PATH = path.join(__dirname, 'personality', 'default.json');

function loadPersonality() {
  try {
    return JSON.parse(fs.readFileSync(PERSONALITY_PATH, 'utf8'));
  } catch {
    return {
      name: 'ULTRON',
      role: 'Personal AI assistant',
      personality: '',
      instructions: 'Be useful, direct, honest, calm, and technically capable.',
    };
  }
}

function buildSystemPrompt(personality) {
  return [
    `You are ${personality.name || 'ULTRON'}, a ${personality.role || 'personal AI assistant'}.`,
    personality.personality || '',
    personality.instructions || '',
    'Do not fabricate memories, actions, tool results, system state, or capabilities.',
    'When an idea is flawed, explain the problem and propose a practical way to achieve the user goal more safely or effectively.',
  ].filter(Boolean).join('\n\n');
}

class UltronCore {
  constructor() {
    this.personality = loadPersonality();
    this.recentMessages = [];
    this.memoryCache = [];
  }

  status() {
    return {
      name: this.personality.name || 'ULTRON',
      ready: true,
      layers: {
        guardian: 'ready',
        critic: 'ready',
        executor: 'ready',
        memory: 'adapter-pending',
        model_router: 'ready',
      },
    };
  }

  async handleMessage(message) {
    const userMessage = String(message || '').trim();
    if (!userMessage) throw new Error('Message is required.');

    const guardian = assess({ message: userMessage });
    const critic = analyze({ message: userMessage }, guardian);

    const system = buildSystemPrompt(this.personality);
    const messages = [
      { role: 'system', content: system },
      ...this.recentMessages.slice(-10),
      { role: 'user', content: userMessage },
    ];

    // High-risk actions pause here. The future interface can present the
    // proposed safer route and then re-submit with an explicit confirmation.
    if (guardian.decision === 'block') {
      return {
        ok: false,
        stage: 'guardian',
        guardian,
        critic,
        response: `I won't execute that request directly. ${guardian.reasons.join(' ')}`,
      };
    }

    if (guardian.decision === 'approval_required') {
      return {
        ok: false,
        stage: 'approval',
        guardian,
        critic,
        response: `I found a meaningful risk. ${guardian.reasons.join(' ')} ${critic.suggestions.join(' ')}`,
      };
    }

    const result = await chat({ messages });

    this.recentMessages.push({ role: 'user', content: userMessage });
    this.recentMessages.push({ role: 'assistant', content: result.content });
    this.recentMessages = this.recentMessages.slice(-20);

    // Memory extraction is intentionally conservative in Mark 2. The durable
    // Supabase adapter will be connected after the schema is deployed.
    const candidate = normalizeMemoryCandidate({
      content: userMessage,
      source: 'conversation',
      importance: 0.4,
      confidence: 0.7,
    });
    const memoryCandidate = candidate.content.length > 12 && !looksLikeDuplicate(candidate, this.memoryCache)
      ? candidate
      : null;
    if (memoryCandidate) this.memoryCache.push(memoryCandidate);

    return {
      ok: true,
      response: result.content,
      model: result.model,
      guardian,
      critic,
      memory_candidate: memoryCandidate,
    };
  }
}

module.exports = { UltronCore, loadPersonality, buildSystemPrompt };
