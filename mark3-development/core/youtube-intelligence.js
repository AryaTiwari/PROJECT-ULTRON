const fs = require('fs');
const path = require('path');
const config = require('./config');
const { readJson, writeJsonAtomic } = require('./persistence');

const ROOT = path.resolve(config.projectRoot, '.ultron', 'reels');
const CACHE_PATH = path.join(ROOT, 'youtube-intelligence.json');
const TTL_MS = Math.max(60 * 60 * 1000, Number(process.env.ULTRON_M3_YOUTUBE_INTEL_TTL_MS || 6 * 60 * 60 * 1000));
const TIMEOUT_MS = Math.max(5000, Number(process.env.ULTRON_M3_YOUTUBE_TIMEOUT_MS || 15000));

function key() { return String(process.env.YOUTUBE_API_KEY || '').trim(); }
function clean(value, max = 240) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max); }
function ensureRoot() { fs.mkdirSync(ROOT, { recursive: true }); }
function cache() { ensureRoot(); return readJson(CACHE_PATH, { version: 1, entries: {} }); }
function saveCache(data) { ensureRoot(); writeJsonAtomic(CACHE_PATH, data); return data; }
function cacheKey(query) { return clean(query, 160).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'creator-intelligence'; }

async function request(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
    if (!response.ok) {
      const message = data?.error?.message || data?.error?.errors?.[0]?.message || raw.slice(0, 600) || `HTTP ${response.status}`;
      const error = new Error(`YouTube Data API HTTP ${response.status}: ${message}`);
      error.status = response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') throw new Error(`YouTube Data API timed out after ${TIMEOUT_MS}ms.`);
    throw error;
  } finally { clearTimeout(timer); }
}

function recentAfter(days = 45) {
  const date = new Date(Date.now() - Math.max(1, Number(days || 45)) * 86400000);
  return date.toISOString();
}

async function searchVideos(query, options = {}) {
  const apiKey = key();
  if (!apiKey) throw new Error('YOUTUBE_API_KEY is not configured.');
  const url = new URL('https://www.googleapis.com/youtube/v3/search');
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('type', 'video');
  url.searchParams.set('maxResults', String(Math.max(3, Math.min(20, Number(options.limit || 10)))));
  url.searchParams.set('q', `${clean(query, 180)} #shorts`);
  url.searchParams.set('order', options.order || 'relevance');
  url.searchParams.set('publishedAfter', options.publishedAfter || recentAfter(options.days || 45));
  url.searchParams.set('regionCode', options.regionCode || 'IN');
  url.searchParams.set('relevanceLanguage', options.language || 'en');
  url.searchParams.set('key', apiKey);
  const data = await request(url.toString());
  return (Array.isArray(data?.items) ? data.items : []).map((item) => ({
    id: String(item?.id?.videoId || '').trim(),
    title: clean(item?.snippet?.title, 240),
    description: clean(item?.snippet?.description, 500),
    channelId: String(item?.snippet?.channelId || '').trim(),
    channelTitle: clean(item?.snippet?.channelTitle, 160),
    publishedAt: String(item?.snippet?.publishedAt || '').trim() || null,
  })).filter((item) => item.id);
}

async function videoStats(ids = []) {
  const apiKey = key();
  if (!apiKey) throw new Error('YOUTUBE_API_KEY is not configured.');
  const selected = [...new Set(ids.map(String).filter(Boolean))].slice(0, 50);
  if (!selected.length) return [];
  const url = new URL('https://www.googleapis.com/youtube/v3/videos');
  url.searchParams.set('part', 'statistics,contentDetails,snippet');
  url.searchParams.set('id', selected.join(','));
  url.searchParams.set('key', apiKey);
  const data = await request(url.toString());
  return (Array.isArray(data?.items) ? data.items : []).map((item) => ({
    id: String(item?.id || '').trim(),
    title: clean(item?.snippet?.title, 240),
    channelTitle: clean(item?.snippet?.channelTitle, 160),
    publishedAt: String(item?.snippet?.publishedAt || '').trim() || null,
    duration: String(item?.contentDetails?.duration || '').trim() || null,
    views: Number(item?.statistics?.viewCount || 0),
    likes: Number(item?.statistics?.likeCount || 0),
    comments: Number(item?.statistics?.commentCount || 0),
  })).filter((item) => item.id);
}

function performanceScore(item) {
  const views = Math.max(1, Number(item?.views || 0));
  const engagement = (Number(item?.likes || 0) + Number(item?.comments || 0) * 2) / views;
  const ageDays = Math.max(0.5, (Date.now() - Date.parse(item?.publishedAt || Date.now())) / 86400000);
  const velocity = Math.log10(views + 10) / Math.sqrt(ageDays);
  return Number((velocity + Math.min(2, engagement * 25)).toFixed(4));
}

function titleTerms(videos = []) {
  const stop = new Set(['this','that','with','your','you','the','and','for','from','are','was','how','why','what','shorts','short','video','instagram','reels','reel']);
  const counts = new Map();
  for (const video of videos) {
    const tokens = clean(video.title, 500).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((token) => token.length >= 4 && !stop.has(token));
    for (const token of new Set(tokens)) counts.set(token, Number(counts.get(token) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([term, hits]) => ({ term, hits }));
}

async function analyze(query, options = {}) {
  const apiKey = key();
  if (!apiKey) return { available: false, configured: false, query: clean(query), reason: 'YOUTUBE_API_KEY is not configured.' };
  const store = cache();
  const id = cacheKey(query);
  const existing = store.entries?.[id];
  if (!options.force && existing?.capturedAt && Date.now() - Date.parse(existing.capturedAt) < TTL_MS) return { ...existing, cached: true };

  const searched = await searchVideos(query, options);
  const stats = await videoStats(searched.map((item) => item.id));
  const byId = new Map(stats.map((item) => [item.id, item]));
  const videos = searched.map((item) => ({ ...item, ...(byId.get(item.id) || {}) }))
    .map((item) => ({ ...item, score: performanceScore(item) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(3, Math.min(12, Number(options.keep || 8))));

  const value = {
    available: true,
    configured: true,
    query: clean(query),
    capturedAt: new Date().toISOString(),
    cached: false,
    provider: 'youtube-data-api-v3',
    region: options.regionCode || 'IN',
    recentDays: Number(options.days || 45),
    videos,
    repeatedTitleTerms: titleTerms(videos),
    caveat: 'Public YouTube metadata is a cross-platform directional signal, not proof that a format will perform on Instagram.',
  };
  store.entries = { ...(store.entries || {}), [id]: value };
  const entries = Object.entries(store.entries).sort((a, b) => String(b[1]?.capturedAt || '').localeCompare(String(a[1]?.capturedAt || ''))).slice(0, 30);
  store.entries = Object.fromEntries(entries);
  saveCache(store);
  return value;
}

function summary(result) {
  if (!result?.available) return 'YouTube Shorts intelligence unavailable.';
  const top = (result.videos || []).slice(0, 5).map((item) => `${item.title} [views=${item.views || 0}, score=${item.score}]`).join(' | ');
  const terms = (result.repeatedTitleTerms || []).slice(0, 8).map((item) => `${item.term}(${item.hits})`).join(', ');
  return `YOUTUBE SHORTS CROSS-PLATFORM SIGNAL (${result.region}, last ${result.recentDays}d): top=${top || 'none'}; repeated title terms=${terms || 'none'}. Treat as directional metadata, not an Instagram guarantee.`;
}

function status() {
  return { implemented: true, configured: Boolean(key()), provider: 'youtube-data-api-v3', cachePath: CACHE_PATH, cacheTtlMs: TTL_MS, readOnly: true, externalSideEffects: false };
}

module.exports = { CACHE_PATH, searchVideos, videoStats, performanceScore, titleTerms, analyze, summary, status };
