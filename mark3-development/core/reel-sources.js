const fs = require('fs');
const path = require('path');
const PEXELS_BASE = 'https://api.pexels.com/v1/videos/search';
const PIXABAY_BASE = 'https://pixabay.com/api/videos/';
const DEFAULT_TIMEOUT_MS = Math.max(5000, Number(process.env.ULTRON_M3_REEL_SOURCE_TIMEOUT_MS || 20000));
const DEFAULT_DOWNLOAD_TIMEOUT_MS = Math.max(15000, Number(process.env.ULTRON_M3_REEL_DOWNLOAD_TIMEOUT_MS || 120000));
const MAX_DOWNLOAD_BYTES = Math.max(5 * 1024 * 1024, Number(process.env.ULTRON_M3_REEL_MAX_ASSET_BYTES || 120 * 1024 * 1024));

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

function safeAssetName(asset, index = 1) {
  const provider = String(asset?.provider || 'stock').replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'stock';
  const id = String(asset?.id || index).replace(/[^a-z0-9_-]/gi, '').slice(0, 48) || String(index);
  return `${String(index).padStart(2, '0')}-${provider}-${id}.mp4`;
}

async function downloadAsset(asset, destination, options = {}) {
  if (!asset?.url) throw new Error('Stock asset has no downloadable URL.');
  const target = path.resolve(destination);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const controller = new AbortController();
  const timeoutMs = Math.max(15000, Number(options.timeoutMs || DEFAULT_DOWNLOAD_TIMEOUT_MS));
  const maxBytes = Math.max(5 * 1024 * 1024, Number(options.maxBytes || MAX_DOWNLOAD_BYTES));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(asset.url, { headers: { Accept: 'video/mp4,application/octet-stream;q=0.9,*/*;q=0.1' }, signal: controller.signal });
    if (!response.ok) throw new Error(`Stock asset download HTTP ${response.status}.`);
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared && declared > maxBytes) throw new Error(`Stock asset is too large (${declared} bytes > ${maxBytes}).`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new Error('Stock asset download returned an empty file.');
    if (bytes.length > maxBytes) throw new Error(`Stock asset is too large (${bytes.length} bytes > ${maxBytes}).`);
    fs.writeFileSync(target, bytes);
    return {
      ok: true,
      path: target,
      bytes: bytes.length,
      provider: asset.provider || null,
      id: asset.id || null,
      attribution: asset.attribution || null,
      sourcePage: asset.sourcePage || null,
    };
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`Stock asset download timed out after ${timeoutMs}ms.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
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
  safeAssetName,
  downloadAsset,
  status,
};
