const dns = require('node:dns').promises;
const net = require('node:net');

const DEFAULT_TIMEOUT_MS = Math.max(3000, Number(process.env.ULTRON_M3_WEB_TIMEOUT_MS || 15000));
const DEFAULT_MAX_BYTES = Math.max(64 * 1024, Number(process.env.ULTRON_M3_WEB_MAX_BYTES || 1024 * 1024));
const DEFAULT_MAX_TEXT = Math.max(4000, Number(process.env.ULTRON_M3_WEB_MAX_TEXT_CHARS || 24000));
const TINYFISH_FETCH_URL = String(process.env.TINYFISH_FETCH_URL || 'https://api.fetch.tinyfish.ai').trim();
const TINYFISH_SEARCH_URL = String(process.env.TINYFISH_SEARCH_URL || 'https://api.search.tinyfish.ai').trim();

function tinyfishApiKey() {
  return String(process.env.TINYFISH_API_KEY || '').trim();
}

function status() {
  return {
    primary: 'tinyfish',
    configured: Boolean(tinyfishApiKey()),
    fetchEndpoint: TINYFISH_FETCH_URL,
    searchEndpoint: TINYFISH_SEARCH_URL,
    fallback: 'direct-http',
  };
}

function normalizeUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('URL is required.');
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(withScheme);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only public HTTP/HTTPS URLs are supported.');
  return url;
}

function isPrivateIp(ip) {
  if (!ip) return true;
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    return parts[0] === 10
      || parts[0] === 127
      || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168)
      || parts[0] === 0;
  }
  const value = ip.toLowerCase();
  return value === '::1' || value.startsWith('fe80:') || value.startsWith('fc') || value.startsWith('fd');
}

async function assertPublicHost(url) {
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('Local/private URLs are not allowed through the public web fetcher.');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('Local/private URLs are not allowed through the public web fetcher.');
    return;
  }
  const addresses = await dns.lookup(host, { all: true });
  if (!addresses.length || addresses.some((entry) => isPrivateIp(entry.address))) {
    throw new Error('The URL resolved to a local/private network address and was blocked.');
  }
}

async function fetchJson(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(3000, Number(timeoutMs || DEFAULT_TIMEOUT_MS)));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; }
    catch { data = { raw }; }
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}: ${raw.slice(0, 1200)}`);
      error.status = response.status;
      error.body = data;
      throw error;
    }
    return data;
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') {
      throw new Error(`Web request timed out after ${Math.max(3000, Number(timeoutMs || DEFAULT_TIMEOUT_MS))}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function tinyfishErrorText(payload) {
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  if (!errors.length) return '';
  return errors.map((entry) => {
    if (typeof entry === 'string') return entry;
    return entry?.message || entry?.error || entry?.detail || JSON.stringify(entry);
  }).filter(Boolean).join(' | ');
}

async function tinyfishFetchPage(input, options = {}) {
  const key = tinyfishApiKey();
  if (!key) throw new Error('TINYFISH_API_KEY is not configured.');
  const requested = normalizeUrl(input);
  await assertPublicHost(requested);
  const timeoutMs = Math.max(5000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
  const payload = await fetchJson(TINYFISH_FETCH_URL, {
    method: 'POST',
    headers: {
      'X-API-Key': key,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      urls: [requested.toString()],
      format: 'markdown',
      links: true,
    }),
  }, timeoutMs);
  const result = Array.isArray(payload?.results) ? payload.results[0] : null;
  const text = String(result?.text || result?.markdown || result?.content || '').trim();
  if (!result || !text) {
    const detail = tinyfishErrorText(payload) || 'TinyFish returned no readable page content.';
    throw new Error(detail);
  }
  const finalUrl = normalizeUrl(result.url || requested.toString());
  await assertPublicHost(finalUrl);
  const maxText = Number(options.maxTextChars || DEFAULT_MAX_TEXT);
  return {
    requestedUrl: requested.toString(),
    url: finalUrl.toString(),
    status: Number(result.status || result.status_code || 200),
    contentType: 'text/markdown',
    title: String(result.title || '').trim(),
    text: text.slice(0, maxText),
    truncated: text.length > maxText,
    provider: 'tinyfish',
    format: String(result.format || 'markdown'),
  };
}

function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(text || '')
    .replace(/&([a-z]+);/gi, (m, name) => named[name.toLowerCase()] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function htmlToText(html) {
  const withoutNoise = String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<(?:br|\/p|\/div|\/section|\/article|\/h[1-6]|li)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(withoutNoise)
    .replace(/[\t\r ]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function titleFromHtml(html) {
  const match = String(html || '').match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeEntities(match[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() : '';
}

async function readLimitedBody(response, maxBytes) {
  if (!response.body) return '';
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      const remaining = Math.max(0, maxBytes - (total - buffer.length));
      if (remaining) chunks.push(buffer.subarray(0, remaining));
      break;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function directFetchPage(input, options = {}) {
  const requested = normalizeUrl(input);
  await assertPublicHost(requested);
  const controller = new AbortController();
  const timeoutMs = Math.max(3000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(requested, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'ULTRON-Mark3/1.0 (+local personal assistant)',
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
      },
    });
    const finalUrl = new URL(response.url || requested.toString());
    await assertPublicHost(finalUrl);
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (!response.ok) throw new Error(`Direct web fetch HTTP ${response.status} for ${finalUrl.hostname}.`);
    const raw = await readLimitedBody(response, Number(options.maxBytes || DEFAULT_MAX_BYTES));
    const text = contentType.includes('html') ? htmlToText(raw) : raw.trim();
    if (!text) throw new Error('The page returned no readable text content.');
    const maxText = Number(options.maxTextChars || DEFAULT_MAX_TEXT);
    return {
      requestedUrl: requested.toString(),
      url: finalUrl.toString(),
      status: response.status,
      contentType,
      title: contentType.includes('html') ? titleFromHtml(raw) : '',
      text: text.slice(0, maxText),
      truncated: text.length > maxText,
      provider: 'direct-http',
      format: contentType.includes('html') ? 'text' : contentType,
    };
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') throw new Error(`Direct web fetch timed out after ${timeoutMs}ms.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPage(input, options = {}) {
  let tinyfishError = null;
  if (tinyfishApiKey()) {
    try {
      return await tinyfishFetchPage(input, options);
    } catch (error) {
      tinyfishError = error;
    }
  }
  try {
    const fallback = await directFetchPage(input, options);
    return { ...fallback, primaryError: tinyfishError ? `TinyFish: ${tinyfishError.message}` : null };
  } catch (fallbackError) {
    const parts = [];
    if (!tinyfishApiKey()) parts.push('TinyFish: TINYFISH_API_KEY is not configured.');
    else if (tinyfishError) parts.push(`TinyFish: ${tinyfishError.message}`);
    parts.push(`Direct fallback: ${fallbackError.message}`);
    const error = new Error(`ULTRON could not fetch this page. ${parts.join(' | ')}`);
    error.status = Number(tinyfishError?.status || fallbackError?.status || 502);
    throw error;
  }
}

async function searchWeb(query, options = {}) {
  const key = tinyfishApiKey();
  const text = String(query || '').trim();
  if (!text) throw new Error('Search query is required.');
  if (!key) throw new Error('TINYFISH_API_KEY is not configured for web search.');
  const limit = Math.max(1, Math.min(10, Number(options.limit || 5)));
  const payload = await fetchJson(`${TINYFISH_SEARCH_URL}?query=${encodeURIComponent(text)}`, {
    method: 'GET',
    headers: { 'X-API-Key': key, Accept: 'application/json' },
  }, Math.max(3000, Number(options.timeoutMs || 10000)));
  const results = (Array.isArray(payload?.results) ? payload.results : []).slice(0, limit).map((item, index) => ({
    position: Number(item?.position || index + 1),
    title: String(item?.title || '').trim(),
    snippet: String(item?.snippet || item?.description || '').trim(),
    url: String(item?.url || '').trim(),
    siteName: String(item?.site_name || item?.siteName || '').trim(),
  })).filter((item) => item.url);
  if (!results.length) throw new Error('TinyFish Search returned no results.');
  return { query: text, results, provider: 'tinyfish-search' };
}

async function searchAndFetch(query, options = {}) {
  const search = await searchWeb(query, { limit: options.searchLimit || 5, timeoutMs: options.searchTimeoutMs });
  const fetchTop = Math.max(0, Math.min(search.results.length, Number(options.fetchTop ?? 3)));
  const pages = [];
  for (const result of search.results.slice(0, fetchTop)) {
    try {
      const page = await fetchPage(result.url, { timeoutMs: options.fetchTimeoutMs || DEFAULT_TIMEOUT_MS, maxTextChars: options.maxTextChars || 10000 });
      pages.push({ ...page, searchTitle: result.title, searchSnippet: result.snippet });
    } catch (error) {
      pages.push({ url: result.url, title: result.title, text: '', error: error.message, provider: 'unavailable' });
    }
  }
  return { ...search, pages };
}

function extractFirstUrl(text) {
  const match = String(text || '').match(/(?:https?:\/\/|www\.)[^\s<>()]+|\b[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?:[\/?#][^\s<>()]*)?/i);
  return match ? match[0].replace(/[),.;!?]+$/, '') : null;
}

function shouldSearch(text) {
  const value = String(text || '').trim();
  if (!value || extractFirstUrl(value)) return false;
  return /\b(?:search(?:\s+the)?\s+web|search\s+online|look\s*up|find\s+(?:online|on\s+the\s+web)|latest\s+(?:news|update|updates|information|info)|recent\s+(?:news|update|updates)|current\s+(?:price|pricing|status|version|news)|today(?:'s)?\s+(?:news|update|updates)|what(?:'s|\s+is)\s+happening\s+with)\b/i.test(value);
}

module.exports = {
  fetchPage,
  directFetchPage,
  tinyfishFetchPage,
  searchWeb,
  searchAndFetch,
  shouldSearch,
  extractFirstUrl,
  normalizeUrl,
  htmlToText,
  status,
};
