const PEXELS_BASE = 'https://api.pexels.com/v1/videos/search';
const PIXABAY_BASE = 'https://pixabay.com/api/videos/';
const DEFAULT_TIMEOUT_MS = Math.max(5000, Number(process.env.ULTRON_M3_REEL_SOURCE_TIMEOUT_MS || 20000));

function firstEnv(...names) {
  for (const name of names) {
    const value = String(process.env[name] || '').trim();
    if (value) return { name, value };
  }
  return { name: null, value: '' };
}

function credentials() {
  return {
    pexels: firstEnv('PEXELS_API_KEY'),
    pixabay: firstEnv('PIXABAY_API_KEY'),
  };
}

async function requestJson(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
    if (!response.ok) {
      const message = data?.error || data?.message || raw.slice(0, 500) || `HTTP ${response.status}`;
      const error = new Error(`Reel source HTTP ${response.status}: ${message}`);
      error.status = response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`Reel source request timed out after ${timeoutMs}ms.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function pexelsFile(video) {
  const files = Array.isArray(video?.video_files) ? video.video_files : [];
  const mp4s = files.filter((item) => String(item?.file_type || '').toLowerCase() === 'video/mp4' && item?.link);
  const portrait = mp4s.filter((item) => Number(item?.height) > Number(item?.width));
  const candidates = portrait.length ? portrait : mp4s;
  return candidates.sort((a, b) => (Number(b?.height || 0) * Number(b?.width || 0)) - (Number(a?.height || 0) * Number(a?.width || 0)))[0] || null;
}

function normalizePexels(video) {
  const file = pexelsFile(video);
  if (!file) return null;
  return {
    provider: 'pexels',
    id: String(video?.id || ''),
    duration: Number(video?.duration || 0) || null,
    width: Number(file?.width || 0) || null,
    height: Number(file?.height || 0) || null,
    url: String(file?.link || ''),
    sourcePage: String(video?.url || ''),
    creator: String(video?.user?.name || ''),
    creatorUrl: String(video?.user?.url || ''),
    attribution: video?.user?.name ? `Video by ${video.user.name} on Pexels` : 'Video provided by Pexels',
  };
}

function pixabayVariant(video) {
  const variants = video?.videos || {};
  const entries = ['large', 'medium', 'small', 'tiny']
    .map((name) => ({ name, ...(variants?.[name] || {}) }))
    .filter((item) => item?.url);
  return entries.sort((a, b) => (Number(b?.height || 0) * Number(b?.width || 0)) - (Number(a?.height || 0) * Number(a?.width || 0)))[0] || null;
}

function normalizePixabay(video) {
  const file = pixabayVariant(video);
  if (!file) return null;
  return {
    provider: 'pixabay',
    id: String(video?.id || ''),
    duration: Number(video?.duration || 0) || null,
    width: Number(file?.width || 0) || null,
    height: Number(file?.height || 0) || null,
    url: String(file?.url || ''),
    sourcePage: String(video?.pageURL || ''),
    creator: String(video?.user || ''),
    creatorUrl: video?.user && video?.user_id ? `https://pixabay.com/users/${encodeURIComponent(video.user)}-${video.user_id}/` : '',
    attribution: video?.user ? `Video by ${video.user} on Pixabay` : 'Video provided by Pixabay',
  };
}

async function searchPexels(query, options = {}) {
  const key = credentials().pexels;
  if (!key.value) throw new Error('PEXELS_API_KEY is not configured.');
  const params = new URLSearchParams({
    query: String(query || '').trim(),
    orientation: String(options.orientation || 'portrait'),
    size: String(options.size || 'medium'),
    per_page: String(Math.min(30, Math.max(1, Number(options.perPage || 8)))),
  });
  const data = await requestJson(`${PEXELS_BASE}?${params.toString()}`, { headers: { Authorization: key.value, Accept: 'application/json' } });
  return (Array.isArray(data?.videos) ? data.videos : []).map(normalizePexels).filter(Boolean);
}

async function searchPixabay(query, options = {}) {
  const key = credentials().pixabay;
  if (!key.value) throw new Error('PIXABAY_API_KEY is not configured.');
  const params = new URLSearchParams({
    key: key.value,
    q: String(query || '').trim().slice(0, 100),
    video_type: 'all',
    safesearch: 'true',
    order: String(options.order || 'popular'),
    per_page: String(Math.min(50, Math.max(3, Number(options.perPage || 8)))),
  });
  const data = await requestJson(`${PIXABAY_BASE}?${params.toString()}`);
  return (Array.isArray(data?.hits) ? data.hits : []).map(normalizePixabay).filter(Boolean);
}

async function searchVideos(query, options = {}) {
  const providers = Array.isArray(options.providers) && options.providers.length ? options.providers : ['pexels', 'pixabay'];
  const errors = [];
  for (const provider of providers) {
    try {
      const items = provider === 'pexels'
        ? await searchPexels(query, options)
        : provider === 'pixabay'
          ? await searchPixabay(query, options)
          : [];
      if (items.length) return { ok: true, provider, query, items, errors };
    } catch (error) {
      errors.push({ provider, error: error.message });
    }
  }
  return { ok: false, provider: null, query, items: [], errors };
}

function status() {
  const creds = credentials();
  return {
    pexelsConfigured: Boolean(creds.pexels.value),
    pixabayConfigured: Boolean(creds.pixabay.value),
    anyConfigured: Boolean(creds.pexels.value || creds.pixabay.value),
    pexelsVariable: creds.pexels.name,
    pixabayVariable: creds.pixabay.name,
  };
}

module.exports = {
  PEXELS_BASE,
  PIXABAY_BASE,
  credentials,
  requestJson,
  normalizePexels,
  normalizePixabay,
  searchPexels,
  searchPixabay,
  searchVideos,
  status,
};
