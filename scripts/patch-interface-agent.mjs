import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('interface');

async function patchApi() {
  const file = path.join(root, 'src', 'services', 'ultronApi.ts');
  let content = await fs.readFile(file, 'utf8');
  const oldFinal = "else if (payload.type === 'final') { finalResult = payload.result || payload; emit({ ...payload, state: 'complete', label: 'Response complete.' }); }";
  const newFinal = "else if (payload.type === 'final') { finalResult = payload.result || payload; emit({ ...payload, state: 'responding', label: 'Text response complete — preparing voice.' }); }";
  if (content.includes(oldFinal)) content = content.replace(oldFinal, newFinal);

  const oldNormalize = "const normalized = normalizeStreamResult(finalResult, activeMood, conversationHistory, userDirectives);\n    if (normalized.response) void speakSequentially(normalized.response);\n    return normalized;";
  const newNormalize = "const normalized = normalizeStreamResult(finalResult, activeMood, conversationHistory, userDirectives);\n    if (normalized.response) await speakSequentially(normalized.response);\n    emitActivity({ type: 'complete', state: 'complete', label: 'Task complete.' });\n    return normalized;";
  if (content.includes(oldNormalize)) content = content.replace(oldNormalize, newNormalize);

  const oldFallback = "if (!sawDelta) return sendUltronQuery(prompt, conversationHistory, activeMood, userDirectives);";
  const newFallback = "if (!sawDelta) { const fallback = await sendUltronQuery(prompt, conversationHistory, activeMood, userDirectives); if (fallback?.response) await speakSequentially(fallback.response); emitActivity({ type: 'complete', state: 'complete', label: 'Task complete.' }); return fallback; }";
  if (content.includes(oldFallback)) content = content.replace(oldFallback, newFallback);
  await fs.writeFile(file, content, 'utf8');
}

async function patchContext() {
  const file = path.join(root, 'src', 'core', 'ultronContext.tsx');
  let content = await fs.readFile(file, 'utf8');
  const old = "let streamingMessageId: string | null = null;\n        const result = await api.sendUltronQueryStream(text.trim(), historyForApi, mood, userRequirements, () => {});";
  const next = `let streamingMessageId: string | null = null;
        const streamEventHandler = (event: any) => {
          if (event?.type === 'delta' && event.text) {
            if (!streamingMessageId) {
              streamingMessageId = \`stream-\${Date.now()}\`;
              setMessages((prev) => [...prev, { id: streamingMessageId!, sender: 'ULTRON', text: event.text, timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }), mood }]);
            } else {
              setMessages((prev) => prev.map((m) => m.id === streamingMessageId ? { ...m, text: \`\${m.text}\${event.text}\` } : m));
            }
            setStatus('RESPONDING');
          } else if (event?.type === 'meta') {
            setStatus(event.state === 'researching' ? 'EXECUTING' : event.state === 'planning' ? 'THINKING' : 'THINKING');
            if (event.task?.taskType) setPipeline((prev) => ({ ...prev, critic: { ...prev.critic, intent: event.task.taskType } }));
          } else if (event?.type === 'tool') {
            setStatus('EXECUTING');
            const firstTool = event.toolCalls?.[0]?.function?.name || event.toolResults?.[0]?.toolCall?.function?.name || null;
            if (firstTool) setActiveTool(firstTool);
          } else if (event?.type === 'error') {
            setStatus('ERROR');
          }
        };
        const result = await api.sendUltronQueryStream(text.trim(), historyForApi, mood, userRequirements, streamEventHandler);`;
  if (content.includes(old)) content = content.replace(old, next);
  await fs.writeFile(file, content, 'utf8');
}

async function main() { await patchApi(); await patchContext(); console.log('[Interface] Agent streaming/voice completion contract applied.'); }
main().catch((error) => { console.error(`[Interface] ${error.message}`); process.exitCode = 1; });
