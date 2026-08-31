import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(projectRoot, 'interface-manifest.json');
const templatePath = path.join(projectRoot, 'scripts', 'templates', 'AgentActivity.tsx');

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        httpsGet(res.headers.location, headers).then(resolve, reject);
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode || 0, body }));
    });
    req.on('error', reject);
  });
}

async function fetchRaw(repository, ref, relativePath) {
  const urls = [
    `https://raw.githubusercontent.com/${repository}/${ref}/${relativePath}`,
    `https://github.com/${repository}/raw/refs/heads/${ref}/${relativePath}`,
    `https://github.com/${repository}/raw/${ref}/${relativePath}`,
  ];
  let lastError = null;
  for (const url of urls) {
    try {
      const result = await httpsGet(url, {
        'User-Agent': 'PROJECT-ULTRON-interface-sync',
        'Accept': 'text/plain,*/*;q=0.8',
      });
      if (result.statusCode === 200) return result.body;
      lastError = new Error(`HTTP ${result.statusCode} for ${url}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`Unable to download ${relativePath}.`);
}

async function fetchContents(repository, ref, relativePath) {
  const encodedPath = relativePath.split('/').map(encodeURIComponent).join('/');
  const url = `https://api.github.com/repos/${repository}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`;
  const result = await httpsGet(url, {
    'User-Agent': 'PROJECT-ULTRON-interface-sync',
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  });
  if (result.statusCode !== 200) throw new Error(`GitHub Contents API HTTP ${result.statusCode} for ${relativePath}`);
  let data;
  try { data = JSON.parse(result.body); } catch { throw new Error(`GitHub Contents API returned non-JSON data for ${relativePath}`); }
  if (data?.content && data?.encoding === 'base64') return Buffer.from(String(data.content).replace(/\n/g, ''), 'base64').toString('utf8');
  if (typeof data?.content === 'string') return data.content;
  throw new Error(`GitHub Contents API returned no usable content for ${relativePath}`);
}

async function fetchInterfaceFile(repository, ref, relativePath) {
  try { return await fetchRaw(repository, ref, relativePath); }
  catch (rawError) {
    console.warn(`[Interface] Raw download failed for ${relativePath}; using GitHub Contents API fallback.`);
    return fetchContents(repository, ref, relativePath).catch(apiError => {
      throw new Error(`${rawError.message} | API fallback failed: ${apiError.message}`);
    });
  }
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

const STREAM_MARKER = '// ULTRON_MARK2_STREAMING_BRIDGE_V2';
const streamBridge = `
${STREAM_MARKER}
export type UltronStreamEvent = { type: 'meta' | 'delta' | 'tool' | 'final' | 'error'; text?: string; result?: any; toolCalls?: any[]; toolResults?: any[]; error?: string; status?: number | null; partial?: boolean; [key: string]: any };

type VoiceWindow = Window & { __ultronVoiceQueue?: (text: string) => Promise<void>; };

function emitActivity(event: any) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('ultron:activity', { detail: { ...event, at: Date.now() } }));
}

function cleanForSpeech(value: string) {
  return String(value || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/https?:\/\/[^\s]+/gi, ' link ')
    .replace(/[{}<>\[\]_*#~|^=+\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitSpeech(text: string, maxChars = 260) {
  const clean = cleanForSpeech(text);
  if (!clean) return [];
  const sentences = clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [clean];
  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    const s = sentence.trim();
    if (!s) continue;
    if ((current + ' ' + s).trim().length <= maxChars) current = (current + ' ' + s).trim();
    else { if (current) chunks.push(current); current = s; }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function speakSequentially(text: string) {
  const enabled = typeof localStorage === 'undefined' || localStorage.getItem('ultron_voice_enabled') !== 'false';
  if (!enabled) return;
  const chunks = splitSpeech(text);
  if (!chunks.length) return;
  const win = window as VoiceWindow;
  if (!win.__ultronVoiceQueue) {
    let tail = Promise.resolve();
    win.__ultronVoiceQueue = (nextText: string) => {
      tail = tail.then(async () => {
        const parts = splitSpeech(nextText);
        for (let i = 0; i < parts.length; i += 1) {
          emitActivity({ type: 'speaking', state: 'speaking', label: `Speaking ${i + 1}/${parts.length}` });
          const response = await fetch(`${CORE_URL}/api/tts/play`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: parts[i] }),
          });
          if (!response.ok) throw new Error(`Voice request failed (${response.status})`);
        }
        emitActivity({ type: 'voice-complete', state: 'complete', label: 'Voice output complete.' });
      }).catch((error) => emitActivity({ type: 'error', state: 'error', label: 'Voice output failed.', error: error?.message || String(error) }));
      return tail;
    };
  }
  await win.__ultronVoiceQueue(text);
}

export async function sendUltronQueryStream(prompt: string, conversationHistory: { role: 'user' | 'model'; content: string }[] = [], activeMood = 'CALM', userDirectives = '', onEvent: (event: UltronStreamEvent) => void = () => {}) {
  let sawDelta = false;
  let controller: AbortController | null = null;
  let firstTokenTimer: ReturnType<typeof setTimeout> | null = null;
  const emit = (event: any) => { onEvent(event); emitActivity(event); };
  try {
    emit({ type: 'meta', state: 'thinking', label: 'Determining the best approach…' });
    controller = new AbortController();
    const timeout = Number(import.meta.env.VITE_ULTRON_FIRST_TOKEN_TIMEOUT_MS || 12000);
    firstTokenTimer = setTimeout(() => { if (!sawDelta) controller?.abort(); }, timeout);
    const res = await fetch(`${CORE_URL}/api/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
      body: JSON.stringify({ message: prompt, source: 'interface', conversationHistory, userDirectives }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`ULTRON streaming request failed (${res.status})`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalResult: any = null;
    const consume = (block: string) => {
      const lines = block.replace(/\r/g, '').split('\n');
      let type = 'message';
      const data: string[] = [];
      for (const line of lines) {
        if (line.startsWith('event:')) type = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (!data.length) return;
      let payload: any = {};
      try { payload = JSON.parse(data.join('\n')); } catch { payload = { text: data.join('\n') }; }
      payload.type = payload.type || type;
      if (payload.type === 'meta') emit({ ...payload, state: payload.state || 'thinking' });
      else if (payload.type === 'delta') { sawDelta = true; if (firstTokenTimer) clearTimeout(firstTokenTimer); emit({ ...payload, state: 'responding' }); }
      else if (payload.type === 'tool') { emit({ ...payload, state: 'executing', label: `Tool activity: ${payload.toolCalls?.length || 1} call(s)` }); }
      else if (payload.type === 'final') { finalResult = payload.result || payload; emit({ ...payload, state: 'complete', label: 'Response complete.' }); }
      else if (payload.type === 'error') emit({ ...payload, state: 'error', label: payload.error || 'ULTRON encountered an error.' });
      else emit(payload);
    };
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) { consume(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2); }
    }
    buffer += decoder.decode(); if (buffer.trim()) consume(buffer);
    if (firstTokenTimer) clearTimeout(firstTokenTimer);
    if (!finalResult) throw new Error('ULTRON streaming ended without a final response.');
    const normalized = normalizeStreamResult(finalResult, activeMood, conversationHistory, userDirectives);
    if (normalized.response) await speakSequentially(normalized.response);
    emitActivity({ type: 'complete', state: 'complete', label: 'Task complete.' });
    return normalized;
  } catch (error: any) {
    if (firstTokenTimer) clearTimeout(firstTokenTimer);
    emit({ type: 'error', state: 'error', label: 'ULTRON request failed.', error: error?.message || String(error), partial: sawDelta });
    if (!sawDelta) return sendUltronQuery(prompt, conversationHistory, activeMood, userDirectives);
    throw error;
  }
}

function normalizeStreamResult(result: any, activeMood: string, conversationHistory: any[], userDirectives: string) {
  const fallbackMood = normalizeMood(activeMood, 'CALM');
  const mood = normalizeMood(result?.mood, fallbackMood);
  const responseText = String(result?.response ?? result?.text ?? result?.error ?? '').trim();
  const pipeline = normalizePipeline(result);
  return { ...result, text: responseText || 'ULTRON returned no displayable response.', response: responseText || 'ULTRON returned no displayable response.', mood, conversationHistory, userDirectives, pipeline, toolUsed: result?.toolUsed || result?.tool_result?.tool || null };
}
`;

async function patchFrontend(targetRoot) {
  const template = await fs.readFile(templatePath, 'utf8');
  const activityPath = path.join(targetRoot, 'src', 'components', 'AgentActivity.tsx');
  await fs.mkdir(path.dirname(activityPath), { recursive: true });
  await fs.writeFile(activityPath, template, 'utf8');

  const servicePath = path.join(targetRoot, 'src', 'services', 'ultronApi.ts');
  let service = await fs.readFile(servicePath, 'utf8');
  const markerIndex = service.indexOf('// ULTRON_MARK2_STREAMING_BRIDGE');
  const markerIndexV2 = service.indexOf(STREAM_MARKER);
  if (markerIndexV2 >= 0) service = service.slice(0, markerIndexV2) + streamBridge;
  else if (markerIndex >= 0) service = service.slice(0, markerIndex) + streamBridge;
  else service += streamBridge;
  await fs.writeFile(servicePath, service, 'utf8');

  const contextPath = path.join(targetRoot, 'src', 'core', 'ultronContext.tsx');
  let context = await fs.readFile(contextPath, 'utf8');
  if (!context.includes('sendUltronQueryStream')) {
    const callRegex = /const result = await api\.sendUltronQuery\(text\.trim\(\), historyForApi, mood, userRequirements\);/;
    context = context.replace(callRegex, `let streamingMessageId: string | null = null;\n        const result = await api.sendUltronQueryStream(text.trim(), historyForApi, mood, userRequirements, () => {});`);
    context = context.replace(`setMessages((prev) => [...prev, ultronMsg]);`, `setMessages((prev) => streamingMessageId ? prev.map((m) => m.id === streamingMessageId ? ultronMsg : m) : [...prev, ultronMsg]);`);
  }
  await fs.writeFile(contextPath, context, 'utf8');

  const chatPath = path.join(targetRoot, 'src', 'components', 'UltronChatPage.tsx');
  let chat = await fs.readFile(chatPath, 'utf8');
  if (!chat.includes("from './AgentActivity'")) chat = chat.replace("import { useDynamicRgbColor } from '../utils/dynamicRgb';", "import { useDynamicRgbColor } from '../utils/dynamicRgb';\nimport { AgentActivity } from './AgentActivity';");
  if (!chat.includes('<AgentActivity />')) chat = chat.replace('{/* Cybernetic Background Grid Overlay */}', '<AgentActivity />\n\n          {/* Cybernetic Background Grid Overlay */}');
  await fs.writeFile(chatPath, chat, 'utf8');
}

async function main() {
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const targetRoot = path.join(projectRoot, manifest.root);
  console.log(`[Interface] Syncing Interface1 ${manifest.repository}@${manifest.ref} ...`);
  await fs.mkdir(targetRoot, { recursive: true });
  for (const relativePath of manifest.files) {
    const destination = path.join(targetRoot, relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const content = await fetchInterfaceFile(manifest.repository, manifest.ref, relativePath);
    await fs.writeFile(destination, content, 'utf8');
    console.log(`[Interface] synced ${relativePath}`);
  }
  await fs.writeFile(path.join(targetRoot, 'vite.config.ts'), localViteConfig, 'utf8');
  await fs.writeFile(path.join(targetRoot, '.source-ref'), `${manifest.ref}\n`, 'utf8');
  await fs.writeFile(path.join(targetRoot, '.interface-sync-version'), `${manifest.syncVersion || 'ultron-agent-ui-v2'}\n`, 'utf8');
  await patchFrontend(targetRoot);
  console.log('[Interface] ULTRON cognitive activity + streaming + voice bridge applied.');
}

main().catch((error) => { console.error(`[Interface] ${error.message}`); process.exitCode = 1; });
