const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const PEXELS_BASE = 'https://api.pexels.com/v1/videos/search';
const PIXABAY_BASE = 'https://pixabay.com/api/videos/';
const DEFAULT_TIMEOUT_MS = Math.max(5000, Number(process.env.ULTRON_M3_REEL_SOURCE_TIMEOUT_MS || 20000));
const DEFAULT_DOWNLOAD_TIMEOUT_MS = Math.max(15000, Number(process.env.ULTRON_M3_REEL_DOWNLOAD_TIMEOUT_MS || 120000));
const MAX_DOWNLOAD_BYTES = Math.max(5 * 1024 * 1024, Number(process.env.ULTRON_M3_REEL_MAX_ASSET_BYTES || 120 * 1024 * 1024));
const PIXABAY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_DIR = path.resolve(config.projectRoot, '.ultron', 'reel-source-cache');

let pixabayCooldownUntil = 0;
let pixabayLastRateLimit = null;

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

function rateLimitSnapshot(response) {
  if (!response?.headers) return null;
  const limit = Number(response.headers.get('x-ratelimit-limit'));
  const remaining = Number(response.headers.get('x-ratelimit-remaining'));
  const resetRaw = response.headers.get('x-ratelimit-reset');
  const retryAfterRaw = response.headers.get('retry-after');
  const resetSec = Number(resetRaw);
  const retryAfterSec = Number(retryAfterRaw);
  return {
    limit: Number.isFinite(limit) ? limit : null,
    remaining: Number.isFinite(remaining) ? remaining : null,
    resetSec: Number.isFinite(resetSec) ? resetSec : null,
    retryAfterSec: Number.isFinite(retryAfterSec) ? retryAfterSec : null,
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
      error.rateLimit = rateLimitSnapshot(response);
      throw error;
    }
    return { data, rateLimit: rateLimitSnapshot(response) };
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`Reel source request timed out after ${timeoutMs}ms.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function cachePath(provider, query, options = {}) {
  const fingerprint = JSON.stringify({ provider, query: String(query || '').trim().toLowerCase(), options });
  const id = crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0, 32);
  return path.join(CACHE_DIR, `${provider}-${id}.json`);
}

function readCache(file, ttlMs) {
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > ttlMs) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(data), 'utf8');
    fs.renameSync(temp, file);
  } catch {}
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
    mediaType: 'video',
    id: String(video?.id || ''),
    duration: Number(video?.duration || 0) || null,
    width: Number(file?.width || 0) || null,
    height: Number(file?.height || 0) || null,
    url: String(file?.link || ''),
    sourcePage: String(video?.url || ''),
    creator: String(video?.user?.name || ''),
    creatorUrl: String(video?.user?.url || ''),
    attribution: video?.user?.name ? `Video by ${video.user.name} on Pexels` : 'Video provided by Pexels',
    license: 'Pexels License',
    commercialUse: true,
  };
}

function pixabayFile(video) {
  const variants = Object.values(video?.videos || {}).filter((item) => item?.url);
  const portrait = variants.filter((item) => Number(item?.height) > Number(item?.width));
  const candidates = portrait.length ? portrait : variants;
  return candidates.sort((a, b) => {
    const aArea = Number(a?.height || 0) * Number(a?.width || 0);
    const bArea = Number(b?.height || 0) * Number(b?.width || 0);
    return bArea - aArea;
  })[0] || null;
}

function normalizePixabay(video) {
  const file = pixabayFile(video);
  if (!file) return null;
  const user = String(video?.user || '').trim();
  const userId = String(video?.user_id || '').trim();
  return {
    provider: 'pixabay',
    mediaType: 'video',
    id: String(video?.id || ''),
    duration: Number(video?.duration || 0) || null,
    width: Number(file?.width || 0) || null,
    height: Number(file?.height || 0) || null,
    url: String(file?.url || ''),
    sourcePage: String(video?.pageURL || ''),
    creator: user,
    creatorUrl: user && userId ? `https://pixabay.com/users/${encodeURIComponent(user)}-${encodeURIComponent(userId)}/` : '',
    attribution: user ? `Video by ${user} via Pixabay` : 'Video provided by Pixabay',
    license: 'Pixabay Content License',
    commercialUse: true,
    tags: String(video?.tags || ''),
    popularity: {
      views: Number(video?.views || 0),
      downloads: Number(video?.downloads || 0),
      likes: Number(video?.likes || 0),
    },
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
  const response = await requestJson(`${PEXELS_BASE}?${params.toString()}`, { headers: { Authorization: key.value, Accept: 'application/json' } });
  const data = response.data;
  return (Array.isArray(data?.videos) ? data.videos : []).map(normalizePexels).filter(Boolean);
}

function pixabayCooldownRemainingSec() {
  return Math.max(0, Math.ceil((pixabayCooldownUntil - Date.now()) / 1000));
}

function setPixabayCooldown(error) {
  const rate = error?.rateLimit || {};
  const seconds = Math.max(5, Number(rate.retryAfterSec || rate.resetSec || 60));
  pixabayCooldownUntil = Date.now() + seconds * 1000;
  pixabayLastRateLimit = {
    at: new Date().toISOString(),
    status: Number(error?.status || 429),
    limit: rate.limit ?? null,
    remaining: rate.remaining ?? 0,
    resetSec: seconds,
  };
}

async function searchPixabay(query, options = {}) {
  const key = credentials().pixabay;
  if (!key.value) throw new Error('PIXABAY_API_KEY is not configured.');
  const requestOptions = {
    order: String(options.order || 'popular'),
    perPage: Math.min(40, Math.max(3, Number(options.perPage || 8))),
    orientation: String(options.orientation || 'portrait'),
  };
  const cache = cachePath('pixabay', query, requestOptions);
  const cached = readCache(cache, PIXABAY_CACHE_TTL_MS);
  if (cached) {
    let items = (Array.isArray(cached?.hits) ? cached.hits : []).map(normalizePixabay).filter(Boolean);
    if (requestOptions.orientation === 'portrait') {
      const portrait = items.filter((item) => Number(item?.height) > Number(item?.width));
      if (portrait.length) items = portrait;
    }
    return items;
  }

  const remaining = pixabayCooldownRemainingSec();
  if (remaining > 0) {
    const error = new Error(`Pixabay is cooling down after a rate limit; retry in about ${remaining}s.`);
    error.status = 429;
    error.cooldown = true;
    throw error;
  }

  const params = new URLSearchParams({
    key: key.value,
    q: String(query || '').trim().slice(0, 100),
    video_type: 'all',
    safesearch: 'true',
    order: requestOptions.order,
    per_page: String(requestOptions.perPage),
  });

  let response;
  try {
    response = await requestJson(`${PIXABAY_BASE}?${params.toString()}`, { headers: { Accept: 'application/json' } });
  } catch (error) {
    if (Number(error?.status) === 429) setPixabayCooldown(error);
    throw error;
  }

  const data = response.data;
  if (response.rateLimit) {
    pixabayLastRateLimit = {
      at: new Date().toISOString(),
      status: 200,
      limit: response.rateLimit.limit,
      remaining: response.rateLimit.remaining,
      resetSec: response.rateLimit.resetSec,
    };
  }
  writeCache(cache, data);

  let items = (Array.isArray(data?.hits) ? data.hits : []).map(normalizePixabay).filter(Boolean);
  if (requestOptions.orientation === 'portrait') {
    const portrait = items.filter((item) => Number(item?.height) > Number(item?.width));
    if (portrait.length) items = portrait;
  }
  return items;
}

function interleave(lists, offset = 0) {
  const active = lists.filter((list) => Array.isArray(list) && list.length);
  if (!active.length) return [];
  const normalizedOffset = ((Math.floor(Number(offset || 0)) % active.length) + active.length) % active.length;
  const rotated = active.map((_, index) => active[(index + normalizedOffset) % active.length]);
  const output = [];
  const seen = new Set();
  const max = Math.max(...rotated.map((list) => list.length));
  for (let i = 0; i < max; i += 1) {
    for (const list of rotated) {
      const item = list[i];
      if (!item) continue;
      const key = `${item.provider}:${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(item);
    }
  }
  return output;
}

function providerOffsetForQuery(query, providerCount) {
  const count = Math.max(1, Number(providerCount || 1));
  const digest = crypto.createHash('sha1').update(String(query || '')).digest();
  return digest[0] % count;
}

async function searchVideos(query, options = {}) {
  const errors = [];
  const creds = credentials();
  const jobs = [];
  if (creds.pexels.value) jobs.push(searchPexels(query, options).then((items) => ({ provider: 'pexels', items })).catch((error) => ({ provider: 'pexels', items: [], error })));
  if (creds.pixabay.value) jobs.push(searchPixabay(query, options).then((items) => ({ provider: 'pixabay', items })).catch((error) => ({ provider: 'pixabay', items: [], error })));
  if (!jobs.length) return { ok: false, provider: null, providers: [], query, items: [], errors: [{ provider: 'router', error: 'No Reel stock source API key is configured.' }] };

  const results = await Promise.all(jobs);
  results.forEach((result) => {
    if (result.error) errors.push({ provider: result.provider, error: result.error.message, status: result.error.status || null, cooldown: Boolean(result.error.cooldown) });
  });
  const lists = results.filter((result) => result.items.length).map((result) => result.items);
  const explicitOffset = Number(options.providerOffset);
  const offset = Number.isFinite(explicitOffset) ? explicitOffset : providerOffsetForQuery(query, lists.length);
  const items = interleave(lists, offset);
  const providers = [...new Set(items.map((item) => item.provider))];
  return {
    ok: items.length > 0,
    provider: providers.length > 1 ? 'multi-stock' : (providers[0] || null),
    providers,
    query,
    items,
    errors,
    providerOffset: offset,
    degraded: errors.length > 0 && items.length > 0,
  };
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
      license: asset.license || null,
      commercialUse: asset.commercialUse !== false,
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
  const providers = [
    { provider: 'pexels', configured: Boolean(creds.pexels.value), variable: creds.pexels.name, commercialUse: true },
    {
      provider: 'pixabay',
      configured: Boolean(creds.pixabay.value),
      variable: creds.pixabay.name,
      commercialUse: true,
      coolingDown: pixabayCooldownRemainingSec() > 0,
      cooldownRemainingSec: pixabayCooldownRemainingSec(),
      lastRateLimit: pixabayLastRateLimit,
    },
  ];
  return {
    provider: providers.filter((item) => item.configured).length > 1 ? 'multi-stock' : (providers.find((item) => item.configured)?.provider || null),
    providers,
    pexelsConfigured: Boolean(creds.pexels.value),
    pixabayConfigured: Boolean(creds.pixabay.value),
    anyConfigured: providers.some((item) => item.configured),
    configuredCount: providers.filter((item) => item.configured).length,
    pexelsVariable: creds.pexels.name,
    pixabayVariable: creds.pixabay.name,
    selectionPolicy: 'parallel-search-interleaved-v1',
    pixabayCache: { persistent: true, ttlHours: 24, dir: CACHE_DIR },
  };
}

module.exports = {
  PEXELS_BASE,
  PIXABAY_BASE,
  PIXABAY_CACHE_TTL_MS,
  CACHE_DIR,
  credentials,
  rateLimitSnapshot,
  requestJson,
  cachePath,
  readCache,
  writeCache,
  normalizePexels,
  normalizePixabay,
  searchPexels,
  searchPixabay,
  pixabayCooldownRemainingSec,
  setPixabayCooldown,
  interleave,
  providerOffsetForQuery,
  searchVideos,
  safeAssetName,
  downloadAsset,
  status,
};
