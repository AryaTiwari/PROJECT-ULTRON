const crypto = require('crypto');
const { config } = require('./config');
const { loadPersonality, buildSystemPrompt } = require('./personality');
const { assess } = require('./guardian');
const { analyze } = require('./critic');
const { listTools } = require('./executor');
const { chat, streamChat } = require('./model-router');
const { classify } = require('./task-classifier');
const { selectModel } = require('./model-policy');
const local = require('./memory/local-store');
const memoryJudge = require('./memory/judge');
const memoryRetriever = require('./memory/retriever');
const supabase = require('./memory/supabase');
const telemetry = require('./telemetry');
const { registerBuiltinTools } = require('../tools/builtin');

function id() { return crypto.randomUUID(); }
function extractMemoryCandidates(message) {
  const text = String(message || '').trim(); const candidates = [];
  const patterns = [
    { regex: /^my\s+(.{1,80}?)\s+is\s+(.{1,200})[.!]?$/i, type: 'fact' },
    { regex: /^i\s+(?:am|live in|work at|study at|study)\s+(.{1,200})[.!]?$/i, type: 'fact' },
    { regex: /^i\s+(?:like|love|prefer|hate|dislike)\s+(.{1,200})[.!]?$/i, type: 'preference' },
    { regex: /^remember\s+(?:that\s+)?(.{1,250})[.!]?$/i, type: 'fact' },
  ];
  for (const item of patterns) { const match = item.regex.exec(text); if (!match) continue; const content = match.length === 3 ? `${match[1].trim()} is ${match[2].trim()}` : match[1].trim(); candidates.push({ type: item.type, content, importance: 0.7, confidence: 0.85, source: 'conversation' }); break; }
  return candidates;
}
class UltronCore {
  constructor() { registerBuiltinTools(); this.personality = loadPersonality(); this.startedAt = new Date().toISOString(); }
  status() { return { name: this.personality.name, ready: true, layers: { guardian: 'ready', critic: 'ready', executor: 'ready', memory: supabase.available() ? 'supabase+local' : 'local-fallback', model_router: 'ready' }, tools: listTools().length, startedAt: this.startedAt }; }
  async getMemories() { if (supabase.available()) { try { const memories = await supabase.listMemories(500); if (Array.isArray(memories)) return memories; } catch {} } return local.getMemories(); }
  async rememberCandidate(candidate) { const memories = await this.getMemories(); const decision = await memoryJudge.judge(candidate, memories); if (decision.decision !== 'SAVE') return decision; const memory = { id: id(), memory_type: candidate.type || 'fact', content: candidate.content, normalized_content: decision.normalized, content_hash: decision.content_hash, importance: candidate.importance ?? 0.5, confidence: candidate.confidence ?? 0.8, source: candidate.source || 'conversation', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), metadata: {} }; local.saveMemory(memory); if (supabase.available()) { try { await supabase.insertMemory(memory); } catch {} } return { ...decision, saved: true, memory }; }
  async getRelevantMemories(userMessage, limit = 8) { return memoryRetriever.retrieve(userMessage, await this.getMemories(), limit); }
  buildMessages(userMessage, memories, recent) { const memoryText = memories.map(m => `- [${m.memory_type || 'fact'}] ${m.content}`).join('\n') || 'No relevant stored memories.'; const conversationText = recent.map(m => `${m.role}: ${m.content}`).join('\n') || 'No previous conversation.'; const context = ['RELEVANT LONG-TERM MEMORY:', memoryText, '', 'RECENT CONVERSATION:', conversationText].join('\n'); return [{ role: 'system', content: `${buildSystemPrompt(this.personality)}\n\n${context}` }, { role: 'user', content: userMessage }]; }
  async prepareMessage(message, options = {}) {
    const userMessage = String(message || '').trim(); if (!userMessage) throw new Error('Message is required.');
    const timestamp = new Date().toISOString(); const task = classify(userMessage); const selectedModel = selectModel(userMessage, options.model); const guardian = assess({ message: userMessage, action: options.action || null }); const critic = analyze({ message: userMessage, plannedAction: options.action || null }, guardian);
    local.appendConversation({ id: id(), role: 'user', content: userMessage, task_type: task.taskType, created_at: timestamp });
    if (supabase.available()) { try { await supabase.insertConversationMessage({ role: 'user', content: userMessage, metadata: { task_type: task.taskType }, created_at: timestamp }); } catch {} }
    if (guardian.decision === 'block') return { blocked: true, response: `I can't execute that request. ${guardian.reasons.join(' ')}`, guardian, critic, task, selectedModel, memoryResults: [] };
    if (guardian.decision === 'warn' && options.confirmed !== true) return { blocked: true, requires_confirmation: true, response: `Guardian warning: ${guardian.reasons.join(' ')}`, guardian, critic, task, selectedModel, memoryResults: [] };
    if (critic.status === 'blocked') return { blocked: true, requires_confirmation: true, response: 'The request needs a safer approach before execution.', guardian, critic, task, selectedModel, memoryResults: [] };
    const memoryResults = []; for (const candidate of extractMemoryCandidates(userMessage)) memoryResults.push(await this.rememberCandidate(candidate));
    const relevantMemories = await this.getRelevantMemories(userMessage, 8); const recent = local.getRecentMessages(); const messages = this.buildMessages(userMessage, relevantMemories, recent);
    return { userMessage, task, selectedModel, guardian, critic, memoryResults, relevantMemories, messages };
  }
  async finishModelResult(prepared, result, started) {
    await telemetry.recordModelResult({ model: result.model, taskType: prepared.task.taskType, success: true, latencyMs: Date.now() - started });
    const createdAt = new Date().toISOString(); local.appendConversation({ id: id(), role: 'assistant', content: result.content, model: result.model, task_type: prepared.task.taskType, created_at: createdAt });
    if (supabase.available()) { try { await supabase.insertConversationMessage({ role: 'assistant', content: result.content, model: result.model, metadata: { task_type: prepared.task.taskType }, created_at: createdAt }); } catch {} }
    return { ok: true, response: result.content, model: result.model, task: prepared.task, guardian: prepared.guardian, critic: prepared.critic, memory: prepared.memoryResults, relevant_memories: prepared.relevantMemories, tools: listTools() };
  }
  async handleMessage(message, options = {}) {
    const prepared = await this.prepareMessage(message, options); if (prepared.blocked) return { ok: true, response: prepared.response, requires_confirmation: prepared.requires_confirmation, guardian: prepared.guardian, critic: prepared.critic, task: prepared.task, model: prepared.selectedModel, memory: prepared.memoryResults };
    const started = Date.now(); try { return await this.finishModelResult(prepared, await chat({ messages: prepared.messages, model: prepared.selectedModel, taskType: prepared.task.taskType }), started); } catch (error) { await telemetry.recordModelResult({ model: prepared.selectedModel, taskType: prepared.task.taskType, success: false, latencyMs: Date.now() - started, errorType: error?.name || 'model_error', metadata: { message: String(error?.message || error).slice(0, 500) } }); return { ok: false, error: error.message, guardian: prepared.guardian, critic: prepared.critic, task: prepared.task, model: prepared.selectedModel, memory: prepared.memoryResults }; }
  }
  async handleMessageStream(message, options = {}, onEvent = () => {}) {
    const prepared = await this.prepareMessage(message, options);
    if (prepared.blocked) { onEvent({ type: 'final', result: { ok: true, response: prepared.response, requires_confirmation: prepared.requires_confirmation, guardian: prepared.guardian, critic: prepared.critic, task: prepared.task, model: prepared.selectedModel, memory: prepared.memoryResults } }); return; }
    onEvent({ type: 'meta', task: prepared.task, model: prepared.selectedModel, guardian: prepared.guardian, critic: prepared.critic, memory: prepared.memoryResults, relevant_memories: prepared.relevantMemories });
    const started = Date.now(); let streamedText = '';
    try {
      const result = await streamChat({ messages: prepared.messages, model: prepared.selectedModel, taskType: prepared.task.taskType, onDelta: (text, meta) => { streamedText += text; onEvent({ type: 'delta', text, ...meta }); } });
      const final = await this.finishModelResult(prepared, result, started); onEvent({ type: 'final', result: final });
    } catch (error) {
      await telemetry.recordModelResult({ model: prepared.selectedModel, taskType: prepared.task.taskType, success: false, latencyMs: Date.now() - started, errorType: error?.name || 'model_error', metadata: { message: String(error?.message || error).slice(0, 500), streamedChars: streamedText.length } });
      onEvent({ type: 'error', error: error.message, status: error.status || null, partial: Boolean(streamedText) });
    }
  }
}
module.exports = { UltronCore, extractMemoryCandidates, buildSystemPrompt, config };