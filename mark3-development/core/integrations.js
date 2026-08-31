const config = require('./config');

async function requestJson(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!response.ok) throw new Error(`${response.status}: ${data.message || data.error || text.slice(0, 500)}`);
    return data;
  } finally { clearTimeout(timer); }
}

function githubHeaders() {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (config.githubToken) headers.Authorization = `Bearer ${config.githubToken}`;
  return headers;
}

function githubPath(pathname) {
  return String(pathname).split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

async function githubReadFile(pathname, ref = config.githubBranch) {
  if (!config.githubToken) throw new Error('GITHUB_TOKEN is not configured.');
  const url = `https://api.github.com/repos/${encodeURIComponent(config.githubOwner)}/${encodeURIComponent(config.githubRepo)}/contents/${githubPath(pathname)}?ref=${encodeURIComponent(ref)}`;
  const data = await requestJson(url, { headers: githubHeaders() }, 20000);
  if (data.type !== 'file' || !data.content) throw new Error(`GitHub path is not a readable file: ${pathname}`);
  const decoded = Buffer.from(String(data.content).replace(/\r?\n/g, ''), 'base64').toString('utf8');
  return { path: pathname, ref, sha: data.sha, content: decoded, size: Number(data.size) || 0 };
}

async function githubList(pathname = '', ref = config.githubBranch) {
  if (!config.githubToken) throw new Error('GITHUB_TOKEN is not configured.');
  const suffix = pathname ? `/${githubPath(pathname)}` : '';
  const url = `https://api.github.com/repos/${encodeURIComponent(config.githubOwner)}/${encodeURIComponent(config.githubRepo)}/contents${suffix}?ref=${encodeURIComponent(ref)}`;
  return requestJson(url, { headers: githubHeaders() }, 20000);
}

async function models() {
  return requestJson(`${config.omnirouteBase}/models`, {
    headers: config.omnirouteApiKey ? { Authorization: `Bearer ${config.omnirouteApiKey}` } : {},
  }, 15000);
}

async function chat(messages, model = 'auto', tools = []) {
  const payload = { model, messages, stream: false };
  if (Array.isArray(tools) && tools.length) payload.tools = tools;
  return requestJson(`${config.omnirouteBase}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.omnirouteApiKey ? { Authorization: `Bearer ${config.omnirouteApiKey}` } : {}),
    },
    body: JSON.stringify(payload),
  }, 120000);
}

async function speak(text) {
  return requestJson(`${config.parentCore}/api/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      provider: 'fish-audio-s2.1-pro-free',
      format: 'mp3',
      volume: 2,
      temperature: 0.70,
      topP: 0.76,
      prosody: { speed: 1, volume: 2, normalize_loudness: true },
      chunkLength: 240,
      conditionOnPreviousChunks: true,
    }),
  }, 120000);
}

module.exports = { requestJson, githubReadFile, githubList, models, chat, speak };
