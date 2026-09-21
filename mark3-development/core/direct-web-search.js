'use strict';

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

const CACHE_FILE = path.join(config.projectRoot, '.ultron', 'direct-web-search-cache.json');
const SEARCH_ENDPOINT = 'https://www.bing.com/search';
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
let cache = null;
let nextRequestAt = 0;

function enabled() {
  return !/^(0|false|no|off)$/i.test(String(process.env.ULTRON_M3_DIRECT_WEB_SEARCH_ENABLED ?? '1').trim());
}

function decodeXml(value = '') {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function plainText(value = '') {
  return decodeXml(value).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseBingRss(xml = '', limit = 10) {
  const results = [];
  const itemPattern = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemPattern.exec(String(xml))) && results.length < limit) {
    const item = match[1];
    const field = (name) => {
      const found = item.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, 'i'));
      return found ? found[1] : '';
    };
    const url = plainText(field('link'));
    if (!/^https?:\/\//i.test(url)) continue;
    results.push({
      position: results.length + 1,
      title: plainText(field('title')),
      snippet: plainText(field('description')),
      url,
      siteName: (() => { try { return new URL(url).hostname; } catch { return ''; } })(),
    });
  }
  return results;
}

function parseBingHtml(html = '', limit = 10) {
  const results = [];
  const blocks = String(html).match(/<(?:li|div)\b[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>[\s\S]*?<\/(?:li|div)>/gi) || [];
  for (const block of blocks) {
    if (results.length >= limit) break;
    const anchor = block.match(/<h2[^>]*>[\s\S]*?<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<a\b[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;
    const url = decodeXml(anchor[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
      || block.match(/<div\b[^>]*class="[^"]*\bb_caption\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    results.push({
      position: results.length + 1,
      title: plainText(anchor[2]),
      snippet: plainText(snippetMatch?.[1] || ''),
      url,
      siteName: (() => { try { return new URL(url).hostname; } catch { return ''; } })(),
    });
  }
  return results;
}

function siteConstraint(query = '') {
  const match = String(query).match(/(?:^|\s)site:([^\s"'()]+)/i);
  const raw = String(match?.[1] || '').toLowerCase().replace(/^https?:\/\//, '');
  return raw.split('/')[0].replace(/^www\./, '').replace(/\/$/, '');
}

function matchesSite(url, site) {
  if (!site) return true;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return host === site || host.endsWith(`.${site}`);
  } catch { return false; }
}

function readCache() {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    cache = parsed && typeof parsed === 'object' ? parsed : {};
  } catch { cache = {}; }
  return cache;
}

function persistCache() {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  const entries = Object.entries(readCache())
    .sort((a, b) => Number(b[1]?.savedAt || 0) - Number(a[1]?.savedAt || 0))
    .slice(0, 2000);
  const temporary = `${CACHE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(entries)));
  fs.renameSync(temporary, CACHE_FILE);
}

async function pace() {
  const minimumGap = Math.max(150, Math.min(3000, Number(process.env.ULTRON_M3_DIRECT_WEB_SEARCH_GAP_MS || 450)));
  const wait = Math.max(0, nextRequestAt - Date.now());
  nextRequestAt = Math.max(nextRequestAt, Date.now()) + minimumGap;
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
}

async function search(query, options = {}) {
  if (!enabled()) throw Object.assign(new Error('Direct public web search is disabled.'), { code: 'DIRECT_WEB_SEARCH_DISABLED' });
  const text = String(query || '').trim();
  if (!text) throw new Error('Search query is required.');
  const limit = Math.max(1, Math.min(20, Number(options.limit || 10)));
  const key = `v2|${text.toLowerCase().replace(/\s+/g, ' ')}`;
  const ttlMs = Math.max(60000, Number(options.cacheTtlMs || process.env.ULTRON_M3_DIRECT_WEB_SEARCH_CACHE_TTL_MS || DEFAULT_TTL_MS));
  const cached = readCache()[key];
  if (cached && Date.now() - Number(cached.savedAt || 0) < ttlMs && Array.isArray(cached.results)) {
    return { query: text, results: cached.results.slice(0, limit), provider: 'direct-bing-html', cached: true };
  }

  await pace();
  require('./universal-run-context').provider('publicSearch');
  const controller = new AbortController();
  const timeoutMs = Math.max(3000, Math.min(30000, Number(options.timeoutMs || 10000)));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const params = new URLSearchParams({ q: text, count: String(limit), setlang: 'en-IN', cc: 'in' });
    const response = await fetch(`${SEARCH_ENDPOINT}?${params}`, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
      },
    });
    const raw = await response.text();
    if (!response.ok) throw Object.assign(new Error(`Direct public search failed (${response.status}).`), { status: response.status, code: 'DIRECT_WEB_SEARCH_HTTP' });
    const site = siteConstraint(text);
    let results = parseBingHtml(raw, Math.max(limit, 20)).filter((item) => matchesSite(item.url, site)).slice(0, limit);
    // RSS is a useful keyless fallback for broad searches, but it can ignore
    // site: filters. Never accept it for constrained identity discovery.
    if (!results.length && !site) results = parseBingRss(raw, limit);
    if (!results.length) throw Object.assign(new Error('Direct public search returned no indexed results.'), { code: 'DIRECT_WEB_SEARCH_EMPTY' });
    readCache()[key] = { savedAt: Date.now(), results };
    try { persistCache(); } catch {}
    return { query: text, results, provider: 'direct-bing-html', cached: false };
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') {
      throw Object.assign(new Error(`Direct public search timed out after ${timeoutMs}ms.`), { code: 'DIRECT_WEB_SEARCH_TIMEOUT' });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function status() {
  return {
    enabled: enabled(),
    configured: enabled(),
    provider: 'direct-bing-html',
    apiKeyRequired: false,
    internalMonthlyCap: null,
    cacheFile: CACHE_FILE,
  };
}

module.exports = { search, status, parseBingRss, parseBingHtml, siteConstraint, matchesSite, plainText };
