const config = require('./config');
const { load: loadCredentials } = require('../../core/credentials/local-store');

function withTimeout(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, timeoutMs);
  return { controller, clear: function () { clearTimeout(timer); } };
}

async function resolveOmniRouteApiKey() {
  if (config.omnirouteApiKey) return String(config.omnirouteApiKey).trim();
  try {
    const saved = await loadCredentials();
    return String(saved.OMNIROUTE_API_KEY || saved.ULTRON_OMNIROUTE_API_KEY || '').trim();
  } catch (_) {
    return '';
  }
}

async function requestJson(url, options, timeoutMs) {
  const opts = options || {};
  const timeout = withTimeout(timeoutMs || 30000);
  try {
    const response = await fetch(url, Object.assign({}, opts, { signal: timeout.controller.signal }));
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
    if (!response.ok) {
      throw new Error(String(response.status) + ': ' + String(data.message || data.error || text).slice(0, 500));
    }
    return data;
  } finally {
    timeout.clear();
  }
}

function githubHeaders() {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (config.githubToken) headers.Authorization = 'Bearer ' + config.githubToken;
  return headers;
}

function githubPath(pathname) {
  return String(pathname || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

async function githubReadFile(pathname, ref) {
  if (!config.githubToken) throw new Error('GITHUB_TOKEN is not configured.');
  const useRef = ref || config.githubBranch;
  const url = 'https://api.github.com/repos/' + encodeURIComponent(config.githubOwner) + '/' + encodeURIComponent(config.githubRepo) + '/contents/' + githubPath(pathname) + '?ref=' + encodeURIComponent(useRef);
  const data = await requestJson(url, { headers: githubHeaders() }, 20000);
  if (data.type !== 'file' || !data.content) throw new Error('GitHub path is not a readable file: ' + pathname);
  return {
    path: pathname,
    ref: useRef,
    sha: data.sha,
    content: Buffer.from(String(data.content).replace(/\r?\n/g, ''), 'base64').toString('utf8'),
    size: Number(data.size) || 0
  };
}

async function githubList(pathname, ref) {
  if (!config.githubToken) throw new Error('GITHUB_TOKEN is not configured.');
  const useRef = ref || config.githubBranch;
  const suffix = pathname ? '/' + githubPath(pathname) : '';
  const url = 'https://api.github.com/repos/' + encodeURIComponent(config.githubOwner) + '/' + encodeURIComponent(config.githubRepo) + '/contents' + suffix + '?ref=' + encodeURIComponent(useRef);
  return requestJson(url, { headers: githubHeaders() }, 20000);
}

async function models() {
  const key = await resolveOmniRouteApiKey();
  const headers = {};
  if (key) headers.Authorization = 'Bearer ' + key;
  return requestJson(config.omnirouteBase + '/models', { headers: headers }, 15000);
}

async function chat(messages, model, tools) {
  const key = await resolveOmniRouteApiKey();
  if (!key) throw new Error('OmniRoute API key is not configured.');
  const payload = { model: model || 'auto', messages: messages, stream: false };
  if (Array.isArray(tools) && tools.length) payload.tools = tools;
  return requestJson(config.omnirouteBase + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify(payload)
  }, 120000);
}

async function speak(text) {
  return requestJson(config.parentCore + '/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: text,
      provider: 'fish-audio-s2.1-pro-free',
      format: 'mp3',
      volume: 2,
      temperature: 0.70,
      topP: 0.76,
      prosody: { speed: 1, volume: 2, normalize_loudness: true },
      chunkLength: 240,
      conditionOnPreviousChunks: true
    })
  }, 120000);
}

module.exports = { requestJson, resolveOmniRouteApiKey, githubReadFile, githubList, models, chat, speak };
