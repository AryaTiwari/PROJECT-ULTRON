const dns = require('node:dns').promises;
const net = require('node:net');

const DEFAULT_TIMEOUT_MS = Math.max(3000, Number(process.env.ULTRON_M3_WEB_TIMEOUT_MS || 15000));
const DEFAULT_MAX_BYTES = Math.max(64 * 1024, Number(process.env.ULTRON_M3_WEB_MAX_BYTES || 1024 * 1024));
const DEFAULT_MAX_TEXT = Math.max(4000, Number(process.env.ULTRON_M3_WEB_MAX_TEXT_CHARS || 24000));
const TINYFISH_FETCH_URL = String(process.env.TINYFISH_FETCH_URL || 'https://api.fetch.tinyfish.ai').trim();
const TINYFISH_SEARCH_URL = String(process.env.TINYFISH_SEARCH_URL || 'https://api.search.tinyfish.ai').trim();
const RESEARCH_CACHE_TTL_MS = Math.max(60_000, Number(process.env.ULTRON_M3_RESEARCH_CACHE_TTL_MS || 10 * 60 * 1000));
const RESEARCH_CACHE_MAX = Math.max(8, Number(process.env.ULTRON_M3_RESEARCH_CACHE_MAX || 40));
const HOOTSUITE_TREND_URL = 'https://www.hootsuite.com/trend-analysis-tool';
const AFLUENCER_CREATORS_URL = 'https://afluencer.com/influencers';
const researchCache = new Map();

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
    remoteDns: true,
    canonicalHostRetry: true,
    research: {
      adaptive: true,
      cacheTtlMs: RESEARCH_CACHE_TTL_MS,
      sources: {
        hootsuite: { role: 'creator-trend-signal', url: HOOTSUITE_TREND_URL, access: 'public-web' },
        afluencer: { role: 'creator-collab-market-signal', url: AFLUENCER_CREATORS_URL, access: 'public-indexed-web', exhaustive: false },
        general: { role: 'cross-check-and-current-context', access: 'tinyfish-search-fetch' },
      },
    },
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

function assertRemoteSafeUrl(url) {
  const host = String(url.hostname || '').toLowerCase();
  if (!host) throw new Error('URL hostname is required.');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('Local/private URLs are not allowed through the public web fetcher.');
  }
  if (net.isIP(host) && isPrivateIp(host)) {
    throw new Error('Local/private URLs are not allowed through the public web fetcher.');
  }
}

async function assertPublicHost(url) {
  assertRemoteSafeUrl(url);
  const host = url.hostname.toLowerCase();
  if (net.isIP(host)) return;
  const addresses = await dns.lookup(host, { all: true });
  if (!addresses.length || addresses.some((entry) => isPrivateIp(entry.address))) {
    throw new Error('The URL resolved to a local/private network address and was blocked.');
  }
}

function urlVariants(input) {
  const requested = normalizeUrl(input);
  assertRemoteSafeUrl(requested);
  const variants = [requested];
  if (requested.hostname.toLowerCase().startsWith('www.')) {
    const apex = new URL(requested.toString());
    apex.hostname = requested.hostname.slice(4);
    variants.push(apex);
  }
  return variants;
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

function resultText(result) {
  return String(result?.text || result?.markdown || result?.content || '').trim();
}

async function tinyfishFetchPage(input, options = {}) {
  const key = tinyfishApiKey();
  if (!key) throw new Error('TINYFISH_API_KEY is not configured.');
  const candidates = urlVariants(input);
  const requested = candidates[0];
  const timeoutMs = Math.max(5000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));

  const payload = await fetchJson(TINYFISH_FETCH_URL, {
    method: 'POST',
    headers: {
      'X-API-Key': key,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      urls: candidates.map((url) => url.toString()),
      format: 'markdown',
      links: true,
    }),
  }, timeoutMs);

  const results = Array.isArray(payload?.results) ? payload.results : [];
  const result = results.find((entry) => resultText(entry));
  const text = resultText(result);
  if (!result || !text) {
    const detail = tinyfishErrorText(payload) || 'TinyFish returned no readable page content.';
    throw new Error(detail);
  }

  const finalUrl = normalizeUrl(result.url || requested.toString());
  assertRemoteSafeUrl(finalUrl);
  const maxText = Number(options.maxTextChars || DEFAULT_MAX_TEXT);
  const canonicalRetryUsed = finalUrl.hostname.toLowerCase() !== requested.hostname.toLowerCase();
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
    canonicalRetryUsed,
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

async function directFetchSingle(requested, options = {}) {
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

async function directFetchPage(input, options = {}) {
  const candidates = urlVariants(input);
  const requested = candidates[0];
  const failures = [];
  for (const candidate of candidates) {
    try {
      const page = await directFetchSingle(candidate, options);
      return {
        ...page,
        requestedUrl: requested.toString(),
        canonicalRetryUsed: candidate.hostname.toLowerCase() !== requested.hostname.toLowerCase(),
      };
    } catch (error) {
      failures.push(`${candidate.hostname}: ${error.message}`);
    }
  }
  throw new Error(failures.join(' | '));
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

function hostMatches(url, domain) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

function compactResearchQuery(query, max = 220) {
  return String(query || '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function researchProfile(query) {
  const text = String(query || '').trim();
  const lower = text.toLowerCase();
  const creator = /\b(?:creator|creators|influencer|influencers|reel|reels|instagram|tiktok|youtube|social media|content creator|ugc|audience|brand collab|brand deal)\b/i.test(text);
  const trend = /\b(?:trend|trends|trending|viral|momentum|sentiment|hashtag|emerging|market situation|social listening|what(?:'s| is) working|content opportunity)\b/i.test(text);
  const collab = /\b(?:collab|collabs|collaboration|brand deal|brand deals|sponsor|sponsorship|ambassador|marketplace|campaign|gifting|paid partnership|brand opportunity|brand opportunities|work with brands)\b/i.test(text);
  const business = /\b(?:business|startup|elevate\s*os|market|competitor|pricing|sales|customer|client|saas|revenue|growth|acquisition|marketing|hiring|career|industry)\b/i.test(text);
  const practical = /\b(?:buy|purchase|laptop|phone|software|tool|service|app|platform|travel|hotel|flight|course|college|university|job|role)\b/i.test(text);
  const current = /\b(?:today|current|currently|latest|recent|now|this week|this month|market situation|trend|trending|price|pricing|news|update|available|availability|open|opportunity|202[4-9])\b/i.test(text);
  const decision = /\b(?:should i|should we|recommend|recommendation|best|compare|comparison|worth it|which|strategy|what should|where should|choose|focus on|priority)\b/i.test(text);
  const explicit = /\b(?:search(?:\s+the)?\s+web|search\s+online|look\s*up|research|find\s+(?:online|on\s+the\s+web)|verify online|check online|latest\s+(?:news|update|updates|information|info)|what(?:'s|\s+is)\s+happening\s+with)\b/i.test(text);
  const marketOpportunity = creator && /\b(?:brand|market|moneti[sz]|opportunit|deal|campaign|sponsor|collab|income|paid)\b/i.test(text);
  const india = /\b(?:india|indian|kolkata|delhi|mumbai|bangalore|bengaluru|hyderabad|chennai|pune)\b/i.test(text);
  const globalOnly = /\b(?:global only|worldwide only|outside india|international only)\b/i.test(lower);
  const shouldResearch = explicit || current || (decision && (creator || business || practical)) || (creator && (trend || collab || marketOpportunity));
  const sources = [];
  if (creator && (trend || current || /\b(?:social|instagram|content|creator market|audience)\b/i.test(text))) sources.push('hootsuite');
  if (creator && (collab || marketOpportunity)) {
    if (!globalOnly) sources.push('afluencer-india');
    sources.push('afluencer-global');
  }
  if (shouldResearch) sources.push('general');
  return {
    shouldResearch,
    creator,
    trend,
    collab,
    business,
    practical,
    current,
    decision,
    explicit,
    india,
    sources: [...new Set(sources)],
  };
}

function cacheKey(query, profile) {
  return JSON.stringify([String(query || '').trim().toLowerCase(), profile?.sources || []]);
}

function getCachedResearch(key) {
  const entry = researchCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > RESEARCH_CACHE_TTL_MS) {
    researchCache.delete(key);
    return null;
  }
  return { ...entry.value, research: { ...(entry.value.research || {}), cached: true } };
}

function putCachedResearch(key, value) {
  researchCache.set(key, { at: Date.now(), value });
  while (researchCache.size > RESEARCH_CACHE_MAX) {
    const oldest = researchCache.keys().next().value;
    researchCache.delete(oldest);
  }
}

async function fetchSearchResults(search, options = {}, source = 'general', domain = '') {
  const fetchTop = Math.max(0, Math.min(search.results.length, Number(options.fetchTop ?? 2)));
  const selected = domain ? search.results.filter((item) => hostMatches(item.url, domain)).slice(0, fetchTop) : search.results.slice(0, fetchTop);
  const pages = await Promise.all(selected.map(async (result) => {
    try {
      const page = await fetchPage(result.url, {
        timeoutMs: options.fetchTimeoutMs || DEFAULT_TIMEOUT_MS,
        maxTextChars: options.maxTextChars || 9000,
      });
      return { ...page, provider: `${page.provider}:${source}`, source, searchTitle: result.title, searchSnippet: result.snippet };
    } catch (error) {
      return { url: result.url, title: result.title, text: '', error: error.message, provider: 'unavailable', source };
    }
  }));
  return pages;
}

async function basicSearchAndFetch(query, options = {}) {
  const search = await searchWeb(query, { limit: options.searchLimit || 5, timeoutMs: options.searchTimeoutMs });
  const pages = await fetchSearchResults(search, { ...options, fetchTop: options.fetchTop ?? 2 }, 'general');
  return {
    ...search,
    results: search.results.map((item) => ({ ...item, source: 'general-web', coverage: 'broad public web via TinyFish' })),
    pages,
  };
}

async function hootsuiteResearch(query, options = {}) {
  const topic = compactResearchQuery(query);
  const year = new Date().getFullYear();
  const searchQuery = `site:hootsuite.com ${topic} social media trends ${year}`;
  const [tracker, discovered] = await Promise.allSettled([
    fetchPage(HOOTSUITE_TREND_URL, { timeoutMs: options.fetchTimeoutMs || DEFAULT_TIMEOUT_MS, maxTextChars: options.maxTextChars || 10000 }),
    searchWeb(searchQuery, { limit: 4, timeoutMs: options.searchTimeoutMs || 10000 }),
  ]);

  const results = [];
  const pages = [];
  if (tracker.status === 'fulfilled') {
    pages.push({
      ...tracker.value,
      provider: `${tracker.value.provider}:hootsuite-trends`,
      source: 'hootsuite-trends',
      searchTitle: 'Hootsuite Free Trend Tracker',
      searchSnippet: 'Public Hootsuite/Talkwalker trend signal used for current creator and social-market context.',
    });
    results.push({
      position: 1,
      title: tracker.value.title || 'Hootsuite Free Trend Tracker',
      snippet: 'Current public social-trend signal. Use as a directional trend source and cross-check consequential claims.',
      url: tracker.value.url || HOOTSUITE_TREND_URL,
      siteName: 'Hootsuite',
      source: 'hootsuite-trends',
      coverage: 'public trend tracker; directional signal, not sole authority',
    });
  }

  if (discovered.status === 'fulfilled') {
    const filtered = discovered.value.results.filter((item) => hostMatches(item.url, 'hootsuite.com'));
    for (const item of filtered.slice(0, 3)) {
      if (!results.some((existing) => existing.url === item.url)) {
        results.push({ ...item, source: 'hootsuite-trends', coverage: 'public Hootsuite web evidence' });
      }
    }
    const extraPages = await fetchSearchResults({ ...discovered.value, results: filtered }, { ...options, fetchTop: 1 }, 'hootsuite-trends', 'hootsuite.com');
    for (const page of extraPages) if (!pages.some((existing) => existing.url === page.url)) pages.push(page);
  }

  if (!results.length && !pages.length) {
    const reasons = [tracker, discovered].filter((item) => item.status === 'rejected').map((item) => item.reason?.message || String(item.reason));
    throw new Error(`Hootsuite research unavailable. ${reasons.join(' | ')}`);
  }
  return { source: 'hootsuite', query: searchQuery, results, pages };
}

async function afluencerResearch(query, region = 'global', options = {}) {
  const topic = compactResearchQuery(query);
  const year = new Date().getFullYear();
  const regionText = region === 'india' ? 'India Indian' : 'global worldwide';
  const searchQuery = `site:afluencer.com ${regionText} ${topic} creator collab brand paid gifting ${year}`;
  const search = await searchWeb(searchQuery, { limit: 6, timeoutMs: options.searchTimeoutMs || 10000 });
  const filtered = search.results.filter((item) => hostMatches(item.url, 'afluencer.com'));
  if (!filtered.length) throw new Error(`Afluencer ${region} research returned no public indexed results.`);
  const source = `afluencer-${region}`;
  const results = filtered.slice(0, 5).map((item, index) => ({
    ...item,
    position: index + 1,
    source,
    coverage: 'public/indexed Afluencer web only; logged-in collab directory may contain additional opportunities',
  }));
  const pages = await fetchSearchResults({ ...search, results }, { ...options, fetchTop: options.specializedFetchTop ?? 1 }, source, 'afluencer.com');
  return { source, query: searchQuery, results, pages };
}

function dedupeEvidence(items = []) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const key = String(item?.url || `${item?.source || ''}:${item?.title || ''}`).trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

async function searchAndFetch(query, options = {}) {
  const text = String(query || '').trim();
  if (!text) throw new Error('Search query is required.');
  const profile = researchProfile(text);
  const sources = profile.sources.length ? profile.sources : ['general'];
  const key = cacheKey(text, { ...profile, sources });
  if (options.cache !== false) {
    const cached = getCachedResearch(key);
    if (cached) return cached;
  }

  const jobs = sources.map((source) => {
    if (source === 'hootsuite') return hootsuiteResearch(text, options);
    if (source === 'afluencer-india') return afluencerResearch(text, 'india', options);
    if (source === 'afluencer-global') return afluencerResearch(text, 'global', options);
    return basicSearchAndFetch(text, options).then((result) => ({ source: 'general', query: result.query, results: result.results, pages: result.pages }));
  });

  const settled = await Promise.allSettled(jobs);
  const packets = [];
  const errors = [];
  for (let i = 0; i < settled.length; i += 1) {
    const item = settled[i];
    if (item.status === 'fulfilled') packets.push(item.value);
    else errors.push({ source: sources[i], error: item.reason?.message || String(item.reason) });
  }
  if (!packets.length) throw new Error(errors.map((item) => `${item.source}: ${item.error}`).join(' | ') || 'Research returned no usable evidence.');

  const results = dedupeEvidence(packets.flatMap((packet) => packet.results || [])).slice(0, Math.max(5, Number(options.maxMergedResults || 12)));
  const pages = dedupeEvidence(packets.flatMap((packet) => packet.pages || [])).slice(0, Math.max(3, Number(options.maxMergedPages || 6)));
  const completedSources = packets.map((packet) => packet.source);
  const value = {
    query: text,
    provider: 'tinyfish-adaptive-research',
    results,
    pages,
    research: {
      adaptive: true,
      cached: false,
      requestedSources: sources,
      completedSources,
      errors,
      profile,
      coverageNotes: {
        hootsuite: completedSources.includes('hootsuite') ? 'Directional public social-trend signal; cross-check before consequential decisions.' : null,
        afluencer: completedSources.some((source) => source.startsWith('afluencer-')) ? 'Public/indexed marketplace evidence only; the logged-in Afluencer directory can contain more collabs.' : null,
      },
    },
  };
  if (options.cache !== false) putCachedResearch(key, value);
  return value;
}

function extractFirstUrl(text) {
  const match = String(text || '').match(/(?:https?:\/\/|www\.)[^\s<>()]+|\b[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?:[\/?#][^\s<>()]*)?/i);
  return match ? match[0].replace(/[),.;!?]+$/, '') : null;
}

function shouldSearch(text) {
  const value = String(text || '').trim();
  if (!value || extractFirstUrl(value)) return false;
  return researchProfile(value).shouldResearch;
}

module.exports = {
  fetchPage,
  directFetchPage,
  tinyfishFetchPage,
  searchWeb,
  searchAndFetch,
  basicSearchAndFetch,
  researchProfile,
  hootsuiteResearch,
  afluencerResearch,
  shouldSearch,
  extractFirstUrl,
  normalizeUrl,
  urlVariants,
  htmlToText,
  status,
};
