const web = require('./web');
const tools = require('./free-tool-registry');

let installed = false;
let originalSearchAndFetch = null;
let originalFetchPage = null;
let originalSearchWeb = null;

const TIMEOUT_MS = Math.max(5000, Number(process.env.ULTRON_M3_TURBO_RESEARCH_TIMEOUT_MS || 18000));

async function jsonRequest(url, options = {}, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}: ${String(data?.error || data?.message || raw).slice(0, 700)}`);
      error.status = response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') throw new Error(`Research provider timed out after ${timeoutMs}ms.`);
    throw error;
  } finally { clearTimeout(timer); }
}

async function textRequest(url, options = {}, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const raw = await response.text();
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}: ${raw.slice(0, 700)}`);
      error.status = response.status;
      throw error;
    }
    return { raw, response };
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') throw new Error(`Research provider timed out after ${timeoutMs}ms.`);
    throw error;
  } finally { clearTimeout(timer); }
}

function tavilyKey() { return String(process.env.TAVILY_API_KEY || '').trim(); }
function braveKey() { return String(process.env.BRAVE_SEARCH_API_KEY || '').trim(); }
function firecrawlKey() { return String(process.env.FIRECRAWL_API_KEY || '').trim(); }

async function tavilySearch(query, options = {}) {
  const key = tavilyKey();
  if (!key) throw new Error('TAVILY_API_KEY is not configured.');
  const data = await jsonRequest('https://api.tavily.com/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      query: String(query || '').trim(),
      search_depth: options.deep ? 'advanced' : 'basic',
      max_results: Math.max(1, Math.min(10, Number(options.limit || 6))),
      include_answer: false,
      include_raw_content: false,
    }),
  });
  const results = (Array.isArray(data?.results) ? data.results : []).map((item, index) => ({
    position: index + 1,
    title: String(item?.title || '').trim(),
    snippet: String(item?.content || '').trim(),
    url: String(item?.url || '').trim(),
    siteName: 'Tavily', source: 'tavily-fallback', coverage: 'independent web search fallback',
  })).filter((item) => item.url);
  if (!results.length) throw new Error('Tavily returned no results.');
  return { query, provider: 'tavily-fallback', results, pages: [], research: { adaptive: true, requestedSources: ['tavily'], completedSources: ['tavily'], errors: [], fallback: true } };
}

async function braveSearch(query, options = {}) {
  const key = braveKey();
  if (!key) throw new Error('BRAVE_SEARCH_API_KEY is not configured.');
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', String(query || '').trim());
  url.searchParams.set('count', String(Math.max(1, Math.min(10, Number(options.limit || 6)))));
  const data = await jsonRequest(url.toString(), { headers: { 'X-Subscription-Token': key, Accept: 'application/json' } });
  const rows = Array.isArray(data?.web?.results) ? data.web.results : [];
  const results = rows.map((item, index) => ({
    position: index + 1,
    title: String(item?.title || '').replace(/<[^>]+>/g, '').trim(),
    snippet: String(item?.description || '').replace(/<[^>]+>/g, '').trim(),
    url: String(item?.url || '').trim(),
    siteName: String(item?.profile?.long_name || item?.meta_url?.hostname || 'Brave').trim(),
    source: 'brave-fallback', coverage: 'independent web index fallback',
  })).filter((item) => item.url);
  if (!results.length) throw new Error('Brave Search returned no results.');
  return { query, provider: 'brave-fallback', results, pages: [], research: { adaptive: true, requestedSources: ['brave'], completedSources: ['brave'], errors: [], fallback: true } };
}

async function jinaReaderFetch(input, options = {}) {
  const target = web.normalizeUrl(input).toString();
  const endpoint = `https://r.jina.ai/${target}`;
  const { raw, response } = await textRequest(endpoint, {
    headers: {
      Accept: 'text/markdown,text/plain;q=0.9,*/*;q=0.5',
      'X-Return-Format': 'markdown',
      'X-No-Cache': options.noCache ? 'true' : 'false',
    },
  }, Math.max(TIMEOUT_MS, Number(options.timeoutMs || 0)));
  const text = String(raw || '').trim();
  if (!text) throw new Error('Jina Reader returned no readable content.');
  const maxText = Number(options.maxTextChars || 24000);
  return {
    requestedUrl: target,
    url: target,
    status: response.status,
    contentType: String(response.headers.get('content-type') || 'text/markdown'),
    title: '',
    text: text.slice(0, maxText),
    truncated: text.length > maxText,
    provider: 'jina-reader-fallback',
    format: 'markdown',
    zeroKey: true,
  };
}

async function firecrawlFetch(input, options = {}) {
  const key = firecrawlKey();
  if (!key) throw new Error('FIRECRAWL_API_KEY is not configured.');
  const url = web.normalizeUrl(input).toString();
  const data = await jsonRequest('https://api.firecrawl.dev/v2/scrape', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true, blockAds: true, maxAge: 172800000, timeout: Math.min(60000, Number(options.timeoutMs || TIMEOUT_MS)) }),
  }, Math.max(TIMEOUT_MS, 30000));
  const payload = data?.data || data;
  const text = String(payload?.markdown || payload?.content || '').trim();
  if (!text) throw new Error('Firecrawl returned no readable Markdown.');
  return {
    requestedUrl: url, url: String(payload?.metadata?.sourceURL || payload?.metadata?.url || url), status: Number(payload?.metadata?.statusCode || 200),
    contentType: 'text/markdown', title: String(payload?.metadata?.title || '').trim(), text: text.slice(0, Number(options.maxTextChars || 24000)),
    truncated: text.length > Number(options.maxTextChars || 24000), provider: 'firecrawl-fallback', format: 'markdown',
  };
}

function providerSequence() {
  const sequence = [];
  if (tavilyKey()) sequence.push('tavily');
  if (braveKey()) sequence.push('brave');
  return sequence;
}

async function fallbackSearch(query, options = {}) {
  const failures = [];
  for (const provider of providerSequence()) {
    try {
      if (provider === 'tavily') return await tavilySearch(query, options);
      if (provider === 'brave') return await braveSearch(query, options);
    } catch (error) { failures.push(`${provider}: ${error.message}`); }
  }
  throw new Error(`No configured zero-cost research fallback succeeded.${failures.length ? ` ${failures.join(' | ')}` : ''}`);
}

async function fallbackFetch(input, options = {}) {
  const failures = [];
  try { return await jinaReaderFetch(input, options); }
  catch (error) { failures.push(`jina-reader: ${error.message}`); }
  if (firecrawlKey()) {
    try { return await firecrawlFetch(input, options); }
    catch (error) { failures.push(`firecrawl: ${error.message}`); }
  }
  throw new Error(`No zero-cost extraction fallback succeeded. ${failures.join(' | ')}`);
}

function install() {
  if (installed) return status();
  originalSearchAndFetch = web.searchAndFetch;
  originalFetchPage = web.fetchPage;
  originalSearchWeb = web.searchWeb;

  web.searchAndFetch = async (query, options = {}) => {
    try { return await originalSearchAndFetch(query, options); }
    catch (primaryError) {
      try {
        const fallback = await fallbackSearch(query, { limit: options.searchLimit || 6, deep: Boolean(options.deep) });
        fallback.primaryError = primaryError.message;
        return fallback;
      } catch (fallbackError) {
        const error = new Error(`Primary research failed: ${primaryError.message} | Turbo fallbacks failed: ${fallbackError.message}`);
        error.primaryError = primaryError;
        error.fallbackError = fallbackError;
        throw error;
      }
    }
  };

  web.searchWeb = async (query, options = {}) => {
    try { return await originalSearchWeb(query, options); }
    catch (primaryError) {
      const fallback = await fallbackSearch(query, { limit: options.limit || 6 });
      return { query, provider: fallback.provider, results: fallback.results, primaryError: primaryError.message };
    }
  };

  web.fetchPage = async (input, options = {}) => {
    try { return await originalFetchPage(input, options); }
    catch (primaryError) {
      try {
        const page = await fallbackFetch(input, options);
        page.primaryError = primaryError.message;
        return page;
      } catch (fallbackError) {
        const error = new Error(`Primary fetch failed: ${primaryError.message} | Turbo extraction fallbacks failed: ${fallbackError.message}`);
        error.primaryError = primaryError;
        error.fallbackError = fallbackError;
        throw error;
      }
    }
  };

  installed = true;
  return status();
}

function uninstall() {
  if (!installed) return status();
  if (originalSearchAndFetch) web.searchAndFetch = originalSearchAndFetch;
  if (originalFetchPage) web.fetchPage = originalFetchPage;
  if (originalSearchWeb) web.searchWeb = originalSearchWeb;
  originalSearchAndFetch = originalFetchPage = originalSearchWeb = null;
  installed = false;
  return status();
}

function status() {
  return {
    installed,
    primary: 'tinyfish/direct-http',
    searchFallbacks: providerSequence(),
    fetchFallbacks: ['jina-reader', ...(firecrawlKey() ? ['firecrawl'] : [])],
    fetchFallback: 'jina-reader',
    zeroCostOnly: true,
    toolRegistry: {
      tavily: tools.byId('tavily')?.credentialsReady || false,
      firecrawl: tools.byId('firecrawl')?.credentialsReady || false,
      brave: tools.byId('brave-search')?.credentialsReady || false,
      jinaReaderNoKey: true,
    },
  };
}

module.exports = { tavilySearch, braveSearch, jinaReaderFetch, firecrawlFetch, fallbackSearch, fallbackFetch, providerSequence, install, uninstall, status };
