const fs = require('fs');
const path = require('path');
const { assess } = require('./guardian');
const { analyze } = require('./critic');
const { chat } = require('./model-router');
const { normalizeMemoryCandidate, looksLikeDuplicate, normalizeForComparison } = require('./memory');
const {
  getConfig: getMemoryConfig,
  createConversation,
  saveMemory,
  saveConversationMessage,
} = require('./supabase-memory');

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

function buildSystemPrompt(personality, memories = []) {
  const memoryText = memories.length
    ? memories.map(item => `- ${item.memory_type || item.type}: ${item.content}`).join('\n')
    : 'No relevant stored memories.';

  return [
    `You are ${personality.name || 'ULTRON'}, a ${personality.role || 'personal AI assistant'}.`,
    personality.personality || '',
    personality.instructions || '',
    'Do not fabricate memories, actions, tool results, system state, or capabilities.',
    'When an idea is flawed, explain the problem and propose a practical way to achieve the user goal more safely or effectively.',
    'RELEVANT LONG-TERM MEMORY:',
    memoryText,
  ].filter(Boolean).join('\n\n');
}

function tokenSet(text) {
  return new Set(
    normalizeForComparison(text)
      .split(' ')
      .filter(token => token.length >= 3)
  );
}

function isMemoryCandidate(message) {
  return /\b(remember|don't forget|do not forget|my .* is|i am building|i'm building|i prefer|i like|i dislike|my goal is)\b/i.test(message);
}

function rankRelevantMemories(message, rows = []) {
  const queryTokens = tokenSet(message);
  return rows
    .map(row => {
      const rowTokens = tokenSet(row.content);
      let overlap = 0;
      for (const token of queryTokens) if (rowTokens.has(token)) overlap += 1;
      return { row, score: overlap + Number(row.importance || 0) * 0.25 };
    })
    .filter(item => item.score > 0.25)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(item => item.row);
}

class UltronCore {
  constructor() {
    this.personality = loadPersonality();
    this.recentMessages = [];
    this.memoryCache = [];
    this.conversationId = null;
  }

  status() {
    const memoryConfigured = Boolean(getMemoryConfig().url && getMemoryConfig().key);
    return {
      name: this.personality.name || 'ULTRON',
      ready: true,
      layers: {
        guardian: 'ready',
        critic: 'ready',
        executor: 'ready',
        memory: memoryConfigured ? 'supabase-configured' : 'local-fallback',
        model_router: 'ready',
      },
    };
  }

  async ensureConversation() {
    if (this.conversationId) return this.conversationId;
    if (!getMemoryConfig().url || !getMemoryConfig().key) return null;
    const conversation = await createConversation('ULTRON Mark 2');
    this.conversationId = conversation?.id || null;
    return this.conversationId;
  }

  async retrieveRelevantMemories(message) {
    if (!getMemoryConfig().url || !getMemoryConfig().key) {
      return this.memoryCache.slice(-8);
    }

    try {
      const response = await fetch(`${getMemoryConfig().url}/rest/v1/memories?active=eq.true&order=importance.desc&limit=50`, {
        headers: {
          apikey: getMemoryConfig().key,
          Authorization: `Bearer ${getMemoryConfig().key}`,
        },
      });
      if (!response.ok) return this.memoryCache.slice(-8);
      const rows = await response.json();
      return rankRelevantMemories(message, Array.isArray(rows) ? rows : []);
    } catch {
      return this.memoryCache.slice(-8);
    }
  }

  async handleMessage(message) {
    const userMessage = String(message || '').trim();
    if (!userMessage) throw new Error('Message is required.');

    const guardian = assess({ message: userMessage });
    const critic = analyze({ message: userMessage }, guardian);
    const memories = await this.retrieveRelevantMemories(userMessage);

    const system = buildSystemPrompt(this.personality, memories);
    const messages = [
      { role: 'system', content: system },
      ...this.recentMessages.slice(-10),
      { role: 'user', content: userMessage },
    ];

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

    let memoryResult = null;
    if (isMemoryCandidate(userMessage)) {
      const candidate = normalizeMemoryCandidate({
        content: userMessage,
        source: 'conversation',
        importance: 0.7,
        confidence: 0.9,
      });
      if (!looksLikeDuplicate(candidate, this.memoryCache)) {
        this.memoryCache.push(candidate);
        if (getMemoryConfig().url && getMemoryConfig().key) {
          try { memoryResult = await saveMemory(candidate); } catch (error) {
            memoryResult = { stored: false, error: error.message };
          }
        } else {
          memoryResult = { stored: false, local_only: true };
        }
      } else {
        memoryResult = { stored: false, duplicate: true };
      }
    }

    try {
      const conversationId = await this.ensureConversation();
      if (conversationId) {
        await saveConversationMessage(conversationId, { role: 'user', content: userMessage });
        await saveConversationMessage(conversationId, { role: 'assistant', content: result.content, model: result.model });
      }
    } catch {
      // Conversation persistence must never make an otherwise successful reply fail.
    }

    return {
      ok: true,
      response: result.content,
      model: result.model,
      guardian,
      critic,
      memory_context: memories,
      memory_result: memoryResult,
    };
  }
}

module.exports = { UltronCore, loadPersonality, buildSystemPrompt };
