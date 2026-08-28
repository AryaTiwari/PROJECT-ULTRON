import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(projectRoot, 'interface-manifest.json');

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'PROJECT-ULTRON-interface-sync' } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        fetchText(response.headers.location).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Interface source download failed: HTTP ${response.statusCode} for ${url}`));
        return;
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve(body));
    });
    request.on('error', reject);
  });
}

const localViteConfig = `import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: path.resolve(__dirname),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, '.') } },
  server: { hmr: process.env.DISABLE_HMR !== 'true', watch: process.env.DISABLE_HMR === 'true' ? null : {} },
  build: { outDir: path.resolve(__dirname, 'dist'), emptyOutDir: true },
});
`;

const STREAM_SERVICE_MARKER = '// ULTRON_MARK2_STREAMING_BRIDGE';
const streamServiceCode = `
${STREAM_SERVICE_MARKER}
export type UltronStreamEvent = { type: 'meta' | 'delta' | 'final' | 'error'; text?: string; result?: any; error?: string; status?: number | null; partial?: boolean; [key: string]: any };

export async function sendUltronQueryStream(prompt: string, conversationHistory: { role: 'user' | 'model'; content: string }[] = [], activeMood = 'CALM', userDirectives = '', onEvent: (event: UltronStreamEvent) => void = () => {}) {
  let sawDelta = false;
  try {
    const res = await fetch(\`${'${CORE_URL}'}/api/chat/stream\`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' }, body: JSON.stringify({ message: prompt, source: 'interface', conversationHistory, userDirectives }) });
    if (!res.ok || !res.body) throw new Error(\`ULTRON streaming request failed (\${res.status})\`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalResult: any = null;
    const consume = (block: string) => {
      const lines = block.replace(/\\r/g, '').split('\\n');
      let type = 'message';
      const data: string[] = [];
      for (const line of lines) {
        if (line.startsWith('event:')) type = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (!data.length) return;
      let payload: any = {};
      try { payload = JSON.parse(data.join('\\n')); } catch { payload = { text: data.join('\\n') }; }
      payload.type = payload.type || type;
      if (payload.type === 'delta') sawDelta = true;
      if (payload.type === 'final') finalResult = payload.result || payload;
      onEvent(payload);
    };
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\\r\\n\\r\\n')) >= 0 || (boundary = buffer.indexOf('\\n\\n')) >= 0) {
        const separatorLength = buffer.slice(boundary, boundary + 4) === '\\r\\n\\r\\n' ? 4 : 2;
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + separatorLength);
        consume(block);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
    if (finalResult) return normalizeStreamResult(finalResult, activeMood, conversationHistory, userDirectives);
    throw new Error('ULTRON streaming ended without a final response.');
  } catch (error: any) {
    if (!sawDelta) return sendUltronQuery(prompt, conversationHistory, activeMood, userDirectives);
    throw error;
  }
}

function normalizeStreamResult(result: any, activeMood: string, conversationHistory: { role: 'user' | 'model'; content: string }[], userDirectives: string) {
  const fallbackMood = normalizeMood(activeMood, 'CALM');
  const mood = normalizeMood(result?.mood, fallbackMood);
  const responseText = String(result?.response ?? result?.text ?? result?.error ?? '').trim();
  const pipeline = normalizePipeline(result);
  return { ...result, text: responseText || 'ULTRON returned no displayable response.', response: responseText || 'ULTRON returned no displayable response.', mood, conversationHistory, userDirectives, pipeline, toolUsed: result?.toolUsed || result?.tool_result?.tool || null };
}
`;

async function patchIntegratedInterface(targetRoot) {
  const servicePath = path.join(targetRoot, 'src', 'services', 'ultronApi.ts');
  const contextPath = path.join(targetRoot, 'src', 'core', 'ultronContext.tsx');
  let service = await fs.readFile(servicePath, 'utf8');
  if (!service.includes(STREAM_SERVICE_MARKER)) service += streamServiceCode;

  let context = await fs.readFile(contextPath, 'utf8');
  const fallbackPattern = /const result = await api\.sendUltronQuery\(text\.trim\(\), historyForApi, mood, userRequirements\);/;
  const streamingCall = `let streamingMessageId: string | null = null;
        const streamEventHandler = (event: any) => {
          if (event?.type === 'delta' && event.text) {
            if (!streamingMessageId) {
              streamingMessageId = \`stream-\${Date.now()}\`;
              setMessages((prev) => [...prev, { id: streamingMessageId!, sender: 'ULTRON', text: event.text, timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }), mood }]);
            } else {
              setMessages((prev) => prev.map((m) => m.id === streamingMessageId ? { ...m, text: \`\${m.text}\${event.text}\` } : m));
            }
          }
          if (event?.type === 'meta' && event.task?.taskType) setPipeline((prev) => ({ ...prev, critic: { ...prev.critic, intent: event.task.taskType } }));
        };
        const result = await api.sendUltronQueryStream(text.trim(), historyForApi, mood, userRequirements, streamEventHandler);`;
  if (fallbackPattern.test(context)) context = context.replace(fallbackPattern, streamingCall);

  const messageNeedle = "        setMessages((prev) => [...prev, ultronMsg]);";
  const messageReplacement = `        setMessages((prev) => {
          if (streamingMessageId) return prev.map((m) => m.id === streamingMessageId ? ultronMsg : m);
          return [...prev, ultronMsg];
        });`;
  if (context.includes(messageNeedle)) context = context.replace(messageNeedle, messageReplacement);

  await fs.writeFile(servicePath, service, 'utf8');
  await fs.writeFile(contextPath, context, 'utf8');
  console.log('[Interface] ULTRON Mark 2 streaming bridge applied.');
}

async function main() {
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const targetRoot = path.join(projectRoot, manifest.root);
  const versionFile = path.join(targetRoot, '.source-ref');
  const currentRef = await fs.readFile(versionFile, 'utf8').catch(() => '');
  const entryExists = await fs.stat(path.join(targetRoot, 'src', 'main.tsx')).then(() => true).catch(() => false);

  if (currentRef.trim() === manifest.ref && entryExists) {
    await fs.writeFile(path.join(targetRoot, 'vite.config.ts'), localViteConfig, 'utf8');
    await patchIntegratedInterface(targetRoot);
    return;
  }

  console.log(`[Interface] Syncing Interface1 ${manifest.repository}@${manifest.ref} ...`);
  await fs.mkdir(targetRoot, { recursive: true });
  for (const relativePath of manifest.files) {
    const url = `https://raw.githubusercontent.com/${manifest.repository}/${manifest.ref}/${relativePath}`;
    const destination = path.join(targetRoot, relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const content = await fetchText(url);
    await fs.writeFile(destination, content, 'utf8');
    console.log(`[Interface] synced ${relativePath}`);
  }
  await fs.writeFile(path.join(targetRoot, 'vite.config.ts'), localViteConfig, 'utf8');
  await fs.writeFile(versionFile, `${manifest.ref}\n`, 'utf8');
  await patchIntegratedInterface(targetRoot);
  console.log(`[Interface] Interface1 source ready at ${targetRoot}.`);
}

main().catch((error) => { console.error(`[Interface] ${error.message}`); process.exitCode = 1; });
