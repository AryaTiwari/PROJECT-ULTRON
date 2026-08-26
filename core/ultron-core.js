const crypto = require('crypto');
const { config } = require('./config');
const { loadPersonality, buildSystemPrompt } = require('./personality');
const { assess } = require('./guardian');
const { analyze } = require('./critic');
const { listTools } = require('./executor');
const { chat } = require('./model-router');
const { classify } = require('./task-classifier');
const { selectModel } = require('./model-policy');
const local = require('./memory/local-store');
const memoryJudge = require('./memory/judge');
const supabase = require('./memory/supabase');

function id() {
  return crypto.randomUUID();
}

function extractMemoryCandidates(message) {
  const text = String(message || '').trim();
  const candidates = [];
  const patterns = [
    { regex: /^my\s+(.{1,80}?)\s+is\s+(.{1,200})[.!]?$/i, type: 'fact' },
    { regex: /^i\s+(?:am|live in|work at|study at|study)\s+(.{1,200})[.!]?$/i, type: 'fact' },
    { regex: /^i\s+(?:like|love|prefer|hate|dislike)\s+(.{1,200})[.!]?$/i, type: 'preference' },
    { regex: /^remember\s+(?:that\s+)?(.{1,250})[.!]?$/i, type: 'fact' },
  ];

  for (const item of patterns) {
    const match = item.regex.exec(text);
    if (!match) continue;
    const content = match.length === 3 ? `${match[1].trim()} is ${match[2].trim()}` : match[1].trim();
    candidates.push({ type: item.type, content, importance: 0.7, confidence: 0.85, source: 'conversation' });
    break;
  }
  return candidates;
}

class UltronCore {
  constructor() {
    this.personality = loadPersonality();
    this.startedAt = new Date().toISOString();
  }

  status() {
    return {
      name: this.personality.name,
      ready: true,
      layers: {
        guardian: 'ready',
        critic: 'ready',
        executor: 'ready',
        memory: supabase.available() ? 'supabase+local' : 'local-fallback',
        model_router: 'ready',
      },
      tools: listTools().length,
      startedAt: this.startedAt,
    };
  }

  async getMemories() {
    if (supabase.available()) {
      try {
        return await supabase.listMemories(200);
      } catch {
        // Keep the local store usable when Supabase is temporarily unavailable.
      }
    }
    return local.getMemories();
  }

  async rememberCandidate(candidate) {
    const memories = await this.getMemories();
    const decision = await memoryJudge.judge(candidate, memories);
    if (decision.decision !== 'SAVE') return decision;

    const memory = {
      id: id(),
      memory_type: candidate.type || 'fact',
      content: candidate.content,
      normalized_content: decision.normalized,
      content_hash: decision.content_hash,
      importance: candidate.importance ?? 0.5,
      confidence: candidate.confidence ?? 0.8,
      source: candidate.source || 'conversation',
      active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      metadata: {},
    };

    local.saveMemory(memory);
    if (supabase.available()) {
      try { await supabase.insertMemory(memory); } catch { /* local copy is retained */ }
    }
    return { ...decision, saved: true, memory };
  }

  buildMessages(userMessage, memories, recent) {
    const memoryText = memories.slice(0, 30).map(m => `- [${m.memory_type || 'fact'}] ${m.content}`).join('\n') || 'No stored memories.';
    const conversationText = recent.map(m => `${m.role}: ${m.content}`).join('\n') || 'No previous conversation.';
    const context = [
      'LONG-TERM MEMORY:', memoryText, '',
      'RECENT CONVERSATION:', conversationText,
    ].join('\n');

    return [
      { role: 'system', content: `${buildSystemPrompt(this.personality)}\n\n${context}` },
      { role: 'user', content: userMessage },
    ];
  }

  async handleMessage(message, options = {}) {
    const userMessage = String(message || '').trim();
    if (!userMessage) return { ok: false, error: 'Message is required.' };

    const timestamp = new Date().toISOString();
    const task = classify(userMessage);
    const selectedModel = selectModel(userMessage, options.model);
    const guardian = assess({ message: userMessage, action: options.action || null });
    const critic = analyze({ message: userMessage, plannedAction: options.action || null }, guardian);

    local.appendConversation({ id: id(), role: 'user', content: userMessage, task_type: task.taskType, created_at: timestamp });
    if (supabase.available()) {
      try {
        await supabase.insertConversationMessage({ role: 'user', content: userMessage, metadata: { task_type: task.taskType }, created_at: timestamp });
      } catch { /* local fallback */ }
    }

    if (guardian.decision === 'block') {
      const response = `I can't execute that request. ${guardian.reasons.join(' ')}`;
      local.appendConversation({ id: id(), role: 'assistant', content: response, created_at: new Date().toISOString() });
      return { ok: true, response, blocked: true, guardian, critic, task };
    }

    if (guardian.decision === 'warn' && options.confirmed !== true) {
      return {
        ok: true,
        requires_confirmation: true,
        response: `Guardian warning: ${guardian.reasons.join(' ')}`,
        guardian,
        critic,
        task,
        model: selectedModel,
      };
    }

    if (critic.status === 'blocked') {
      return { ok: true, requires_confirmation: true, response: 'The request needs a safer approach before execution.', guardian, critic, task };
    }

    const memoryCandidates = extractMemoryCandidates(userMessage);
    const memoryResults = [];
    for (const candidate of memoryCandidates) memoryResults.push(await this.rememberCandidate(candidate));

    const memories = await this.getMemories();
    const recent = local.getRecentMessages();
    const messages = this.buildMessages(userMessage, memories, recent);

    let result;
    try {
      result = await chat({ messages, model: selectedModel });
    } catch (error) {
      return { ok: false, error: error.message, guardian, critic, task, model: selectedModel, memory: memoryResults };
    }

    const createdAt = new Date().toISOString();
    local.appendConversation({ id: id(), role: 'assistant', content: result.content, model: result.model, task_type: task.taskType, created_at: createdAt });
    if (supabase.available()) {
      try {
        await supabase.insertConversationMessage({ role: 'assistant', content: result.content, model: result.model, metadata: { task_type: task.taskType }, created_at: createdAt });
      } catch { /* local fallback */ }
    }

    return {
      ok: true,
      response: result.content,
      model: result.model,
      task,
      guardian,
      critic,
      memory: memoryResults,
      tools: listTools(),
    };
  }
}

module.exports = { UltronCore, extractMemoryCandidates, buildSystemPrompt, config };
