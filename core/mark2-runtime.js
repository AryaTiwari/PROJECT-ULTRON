const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { UltronCore } = require('./ultron-core');
const { execute, openAITools, listTools } = require('./executor');

function extractUrl(text) {
  const match = String(text || '').match(/https?:\/\/[^\s]+/i);
  return match ? match[0].replace(/[),.!?]+$/, '') : null;
}

function updateMood(message, result = null) {
  const text = String(message || '').toLowerCase();
  let mood = 'CALM';
  let intensity = 0.1;
  if (/\b(error|failed|broken|problem|urgent|emergency|danger|attack|threat)\b/.test(text)) {
    mood = 'ALERT';
    intensity = 0.75;
  } else if (/\b(joke|funny|haha|lol|sarcasm|roast|stupid)\b/.test(text)) {
    mood = 'AMUSED';
    intensity = 0.55;
  } else if (/\b(why|how|explain|analyze|compare|debug|architecture|design|plan|calculate)\b/.test(text) || String(result?.response || '').length > 1200) {
    mood = 'FOCUSED';
    intensity = 0.45;
  } else if (/\b(wow|awesome|great|perfect|excellent|nice|love)\b/.test(text)) {
    mood = 'CONFIDENT';
    intensity = 0.35;
  }
  const file = path.resolve(process.env.ULTRON_MOOD_FILE || '.ultron/mood.json');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ mood, intensity, updatedAt: new Date().toISOString() }, null, 2));
  } catch {}
  return { mood, intensity };
}

function usableText(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    return value.map(item => typeof item === 'string' ? item : item?.text || item?.content || item?.value || '').filter(Boolean).join('').trim();
  }
  if (value && typeof value === 'object') return String(value.text || value.content || value.value || '').trim();
  return '';
}

function extractQuotedPath(text) {
  const quoted = String(text || '').match(/["'`](.+?)["'`]/);
  if (quoted?.[1]) return quoted[1].trim();
  const match = String(text || '').match(/(?:read|open|inspect|show|fetch)\s+(?:the\s+)?(?:file\s+)?([\w./-]+\.(?:json|js|mjs|cjs|ts|tsx|jsx|css|md|txt|yml|yaml|html))\b/i);
  return match?.[1] || null;
}

function parseGitHubIntent(message) {
  const text = String(message || '').trim();
  if (!/\bgithub\b/i.test(text)) return null;
  const filePath = extractQuotedPath(text);
  if (!filePath) return null;
  const wantsPersonality = /\bpersonality\b/i.test(text) && /\b(tell|describe|what|which|running|current)\b/i.test(text);
  return {
    name: 'github_read_file',
    input: { path: filePath, ref: process.env.GITHUB_BRANCH || 'mark2-development' },
    wantsPersonality,
  };
}

function parseToolIntent(message) {
  const text = String(message || '').trim();
  const normalized = text.replace(/^ultron\s*[,;:-]?\s*/i, '');
  const githubIntent = parseGitHubIntent(normalized);
  if (githubIntent) return githubIntent;
  if (/^speak(?:\s+out\s+loud|\s+this)?\s*[:,-]?\s+/i.test(normalized)) {
    return { name: 'speak_text', input: { text: normalized.replace(/^speak(?:\s+out\s+loud|\s+this)?\s*[:,-]?\s+/i, '').trim() } };
  }
  if (/^say\s+/i.test(normalized)) return { name: 'speak_text', input: { text: normalized.replace(/^say\s+/i, '').trim() } };
  if (/^(open|launch)\s+https?:\/\//i.test(normalized)) return { name: 'open_url', input: { url: extractUrl(normalized) } };
  if (/^(show|list)\s+(files|folders|directory|files in)/i.test(normalized)) {
    const match = normalized.match(/(?:in|of|at)\s+(.+)$/i);
    return { name: 'list_directory', input: { path: match ? match[1].replace(/^["']|["']$/g, '') : '.' } };
  }
  if (/^(what('?s| is) my (computer|pc) (spec|system|hardware)|system info|computer info)$/i.test(normalized)) return { name: 'system_info', input: {} };
  if (/^read file\s+/i.test(normalized)) return { name: 'read_file', input: { path: normalized.replace(/^read file\s+/i, '').trim() } };
  if (/^write file\s+/i.test(normalized)) {
    try { return { name: 'write_file', input: JSON.parse(normalized.replace(/^write file\s+/i, '').trim()) }; } catch { return null; }
  }
  if (/^run powershell\s+/i.test(normalized)) return { name: 'run_powershell', input: { command: normalized.replace(/^run powershell\s+/i, '').trim() } };
  return null;
}

function mergeToolCalls(toolCalls = []) {
  const merged = new Map();
  for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
    const index = call?.index ?? call?.id ?? String(merged.size);
    const existing = merged.get(index) || {
      index,
      id: call?.id || null,
      type: call?.type || 'function',
      function: { name: '', arguments: '' },
    };
    if (call?.id) existing.id = call.id;
    if (call?.type) existing.type = call.type;
    if (call?.function?.name) existing.function.name += call.function.name;
    if (call?.function?.arguments) existing.function.arguments += call.function.arguments;
    merged.set(index, existing);
  }
  return [...merged.values()].map((call, i) => ({
    id: call.id || `ultron-tool-${i}`,
    type: 'function',
    function: { name: call.function.name, arguments: call.function.arguments || '{}' },
  }));
}

function toolCallInput(call) {
  const fn = call?.function || call || {};
  let input = {};
  try { input = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments || '{}') : (fn.arguments || {}); } catch {}
  return { name: fn.name, input };
}

async function executeToolCalls(toolCalls, options = {}) {
  const results = [];
  for (const toolCall of mergeToolCalls(toolCalls)) {
    const { name, input } = toolCallInput(toolCall);
    const result = await execute(name, input, { confirmed: options.confirmed === true, source: options.source || 'model' });
    results.push({ toolCall, result });
  }
  return results;
}

function toolConversationMessages(toolResults) {
  return toolResults.map(({ toolCall, result }) => ({
    role: 'tool',
    tool_call_id: toolCall.id,
    name: toolCall.function.name,
    content: JSON.stringify(result),
  }));
}

function toolSummary(toolResults) {
  return (toolResults || []).map(item => item?.toolCall?.function?.name).filter(Boolean);
}

function formatGitHubReadResult(intent, toolResult) {
  if (!toolResult?.ok) return usableText(toolResult?.error) || 'GitHub file read failed.';
  const payload = toolResult.result || toolResult;
  const content = usableText(payload?.content);
  if (!intent.wantsPersonality) return content || `Read ${payload?.path || intent.input.path}, but the file contained no displayable text.`;
  try {
    const cfg = JSON.parse(content);
    const name = cfg.ULTRON_NAME || cfg.name || 'ULTRON';
    const role = cfg.ULTRON_ROLE || cfg.role || 'Personal AI assistant';
    const personality = cfg.ULTRON_PERSONALITY || cfg.personality || 'Not specified.';
    const instructions = Array.isArray(cfg.ULTRON_INSTRUCTIONS) ? cfg.ULTRON_INSTRUCTIONS : cfg.ULTRON_INSTRUCTIONS ? [cfg.ULTRON_INSTRUCTIONS] : [];
    const lines = [
      `You are running the ${name} personality configuration from ${intent.input.path}.`,
      `Role: ${role}`,
      `Personality: ${personality}`,
    ];
    if (instructions.length) lines.push(`Behavioral directives loaded: ${instructions.length}.`);
    return lines.join('\n');
  } catch {
    return content || `Read ${intent.input.path}, but it was not valid JSON.`;
  }
}

class Mark2Runtime extends UltronCore {
  async handleDeterministicIntent(intent, options = {}) {
    const risky = ['run_powershell', 'write_file'].includes(intent.name);
    const guardian = require('./guardian').assess({
      message: options.originalMessage || '',
      action: risky ? { destructive: true, requiresConfirmation: true } : null,
    });
    const critic = require('./critic').analyze({
      message: options.originalMessage || '',
      plannedAction: risky ? { destructive: true, externalSideEffect: true } : null,
    }, guardian);
    if (guardian.decision === 'block') {
      const response = guardian.reasons.join(' ');
      return { ok: true, blocked: true, response, guardian, critic, mood: updateMood(options.originalMessage || '', { response }) };
    }
    if (guardian.decision === 'warn' && options.confirmed !== true) {
      const response = `Guardian warning: ${guardian.reasons.join(' ')}`;
      return { ok: true, requires_confirmation: true, response, guardian, critic, mood: updateMood(options.originalMessage || '', { response }) };
    }
    const result = await execute(intent.name, intent.input, { confirmed: options.confirmed === true, source: options.source || 'core' });
    const response = intent.name === 'github_read_file' ? formatGitHubReadResult(intent, result) : (result.ok ? (intent.name === 'speak_text' ? 'Voice synthesis completed.' : `${intent.name} completed.`) : result.error);
    return {
      ok: result.ok,
      response,
      text: response,
      tool_result: result,
      toolUsed: intent.name,
      guardian,
      critic,
      mood: updateMood(options.originalMessage || '', { response }),
      pipeline: {
        guardian: { status: guardian.decision === 'allow' ? 'CLEAR' : 'ALERT', riskScore: guardian.riskScore || 0, message: guardian.reasons?.join(' ') || 'Deterministic safety boundary verified.' },
        critic: { status: critic.status === 'approved' ? 'APPROVED' : String(critic.status || 'STANDBY').toUpperCase(), intent: intent.name.toUpperCase(), confidence: critic.confidence || 0.95 },
        executor: { status: result.ok ? 'COMPLETED' : 'ERROR', tool: intent.name },
      },
    };
  }

  async handleMessage(message, options = {}) {
    const userMessage = String(message || '').trim();
    if (!userMessage) return { ok: false, error: 'Message is required.' };
    const intent = parseToolIntent(userMessage);
    if (intent) return this.handleDeterministicIntent(intent, { ...options, originalMessage: userMessage });

    const task = require('./task-classifier').classify(userMessage);
    const selectedModel = require('./model-policy').selectModel(userMessage, options.model);
    const guardian = require('./guardian').assess({ message: userMessage, action: options.action || null });
    const critic = require('./critic').analyze({ message: userMessage, plannedAction: options.action || null }, guardian);
    if (guardian.decision === 'block') return { ok: true, response: `I can't execute that request. ${guardian.reasons.join(' ')}`, blocked: true, guardian, critic, task, model: selectedModel };
    if (guardian.decision === 'warn' && options.confirmed !== true) return { ok: true, response: `Guardian warning: ${guardian.reasons.join(' ')}`, requires_confirmation: true, guardian, critic, task, model: selectedModel };

    const memories = await this.getRelevantMemories(userMessage, 8);
    const recent = require('./memory/local-store').getRecentMessages();
    const messages = this.buildMessages(userMessage, memories, recent);
    const router = require('./model-router');
    const tools = openAITools();
    let working = [...messages];
    let result = null;
    for (let round = 0; round < Number(process.env.ULTRON_MAX_TOOL_ROUNDS || 4); round += 1) {
      result = await router.chat({ messages: working, model: selectedModel, taskType: task.taskType, tools });
      const calls = mergeToolCalls(result.toolCalls);
      if (!calls.length) break;
      const toolResults = await executeToolCalls(calls, options);
      working = [...working, { role: 'assistant', content: usableText(result.content) || null, tool_calls: calls }, ...toolConversationMessages(toolResults)];
      result = { ...result, toolCalls: [] };
    }
    const response = usableText(result?.content || result?.response) || 'ULTRON completed the request but produced no displayable response.';
    return { ok: true, response, text: response, model: result?.model || selectedModel, task, guardian, critic, memory: [], relevant_memories: memories, tools: listTools(), toolUsed: null, pipeline: { guardian: { status: 'CLEAR', riskScore: guardian.riskScore || 0, message: 'Deterministic safety boundary verified.' }, critic: { status: 'APPROVED', intent: task.taskType || 'GENERAL', confidence: critic.confidence || 0.95 }, executor: { status: 'COMPLETED', tool: null } } };
  }

  async handleMessageStream(message, options = {}, onEvent = () => {}) {
    const userMessage = String(message || '').trim();
    if (!userMessage) { onEvent({ type: 'error', state: 'error', error: 'Message is required.' }); return; }

    const deterministic = parseToolIntent(userMessage);
    if (deterministic) {
      onEvent({ type: 'meta', state: 'thinking', label: 'Understanding the requested operation.' });
      onEvent({ type: 'meta', state: 'executing', label: `Executing ${deterministic.name}.`, tool: deterministic.name, toolCalls: [{ function: { name: deterministic.name } }] });
      const result = await this.handleDeterministicIntent(deterministic, { ...options, originalMessage: userMessage });
      onEvent({ type: 'tool', state: 'executing', label: `${deterministic.name} complete.`, tool: deterministic.name, toolResults: [{ toolCall: { function: { name: deterministic.name } }, result: result.tool_result || result }] });
      onEvent({ type: 'meta', state: 'synthesizing', label: 'Preparing the final response.' });
      onEvent({ type: 'final', state: 'responding', label: 'Text generation complete.', result: { ...result, durationMs: 0 } });
      return;
    }

    const task = require('./task-classifier').classify(userMessage);
    const selectedModel = require('./model-policy').selectModel(userMessage, options.model);
    const guardian = require('./guardian').assess({ message: userMessage, action: options.action || null });
    const critic = require('./critic').analyze({ message: userMessage, plannedAction: options.action || null }, guardian);
    onEvent({ type: 'meta', state: 'thinking', label: 'Evaluating command parameters…', task, model: selectedModel, guardian, critic });

    if (guardian.decision === 'block' || (guardian.decision === 'warn' && options.confirmed !== true) || critic.status === 'blocked') {
      const response = guardian.decision === 'block' ? `I can't execute that request. ${guardian.reasons.join(' ')}` : guardian.decision === 'warn' ? `Guardian warning: ${guardian.reasons.join(' ')}` : 'The request needs a safer approach before execution.';
      onEvent({ type: 'final', state: 'complete', label: 'Task complete.', result: { ok: true, response, text: response, guardian, critic, task, model: selectedModel } });
      return;
    }

    onEvent({ type: 'meta', state: 'planning', label: `Planning a ${task.taskType || 'general'} response.` });
    const memories = await this.getRelevantMemories(userMessage, 8);
    const recent = require('./memory/local-store').getRecentMessages();
    let working = this.buildMessages(userMessage, memories, recent);
    const router = require('./model-router');
    const tools = openAITools();
    const started = Date.now();

    for (let round = 0; round < Number(process.env.ULTRON_MAX_TOOL_ROUNDS || 4); round += 1) {
      onEvent({ type: 'meta', state: round === 0 ? 'researching' : 'synthesizing', label: round === 0 ? 'Inspecting relevant context.' : 'Analyzing tool results.' });
      let streamedText = '';
      let result;
      try {
        result = await router.streamChat({
          messages: working,
          model: selectedModel,
          taskType: task.taskType,
          tools,
          onDelta: (text, meta) => {
            const chunk = usableText(text);
            if (!chunk) return;
            streamedText += chunk;
            onEvent({ type: 'delta', state: 'responding', text: chunk, ...meta });
          },
        });
      } catch (error) {
        onEvent({ type: 'error', state: 'error', label: 'ULTRON request failed.', error: error?.message || String(error), partial: Boolean(streamedText) });
        return;
      }

      const calls = mergeToolCalls(result?.toolCalls);
      const text = usableText(result?.content || result?.response || streamedText);
      if (!calls.length) {
        if (!text) {
          const fallback = await this.handleMessage(userMessage, options);
          const fallbackText = usableText(fallback?.response || fallback?.text || fallback?.content);
          if (fallbackText) {
            onEvent({ type: 'delta', state: 'responding', text: fallbackText, fallback: true });
            onEvent({ type: 'final', state: 'responding', label: 'Text generation complete.', result: { ...fallback, response: fallbackText, text: fallbackText, durationMs: Date.now() - started } });
            return;
          }
          onEvent({ type: 'error', state: 'error', label: 'ULTRON produced no usable response.', error: 'No displayable text was produced.' });
          return;
        }
        onEvent({ type: 'meta', state: 'synthesizing', label: 'Final response ready.' });
        onEvent({ type: 'final', state: 'responding', label: 'Text generation complete.', result: { ok: true, response: text, text, model: result?.model || selectedModel, task, guardian, critic, relevant_memories: memories, durationMs: Date.now() - started } });
        return;
      }

      onEvent({ type: 'meta', state: 'executing', label: `Executing ${calls.length} tool ${calls.length === 1 ? 'call' : 'calls'}.`, toolCalls: calls });
      const toolResults = await executeToolCalls(calls, options);
      onEvent({ type: 'tool', state: 'executing', label: 'Tool execution complete.', toolCalls: calls, toolResults, tools: toolSummary(toolResults) });
      working = [...working, { role: 'assistant', content: text || null, tool_calls: calls }, ...toolConversationMessages(toolResults)];
      onEvent({ type: 'meta', state: 'synthesizing', label: 'Tool results received. Continuing analysis.' });
    }

    onEvent({ type: 'error', state: 'error', label: 'Tool execution limit reached.', error: 'ULTRON exhausted the configured tool rounds before producing a final answer.' });
  }
}

module.exports = { Mark2Runtime, parseToolIntent, parseGitHubIntent, updateMood, mergeToolCalls };