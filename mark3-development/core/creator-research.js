const path = require('path');
const config = require('./config');
const web = require('./web');
const turboResearch = require('./research-turbo-runtime');
const { readJson, writeJsonAtomic } = require('./persistence');

const STORE_PATH = path.join(config.dataDir, 'creator-leads.json');
const DEFAULT_MARKET = String(process.env.ULTRON_M3_CREATOR_MARKET || 'India').trim() || 'India';
const DEFAULT_LIMIT = Math.max(5, Math.min(50, Number(process.env.ULTRON_M3_CREATOR_DEFAULT_LIMIT || 20)));
const DEFAULT_CITIES = String(process.env.ULTRON_M3_CREATOR_CITIES || 'Mumbai,Delhi,Bengaluru,Kolkata,Hyderabad,Chennai,Pune,Ahmedabad,Jaipur,Surat,Chandigarh,Lucknow,Indore,Kochi')
  .split(',').map((item) => item.trim()).filter(Boolean);
const RESERVED_IG_PATHS = new Set(['p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'direct', 'about', 'developer', 'web', 'legal', 'privacy', 'terms']);

function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function normalizeHandle(value) {
  return clean(value).replace(/^@+/, '').replace(/\/$/, '').toLowerCase();
}
function instagramHandleFromUrl(value) {
  try {
    const url = new URL(value);
    if (!/(^|\.)instagram\.com$/i.test(url.hostname)) return '';
    const first = url.pathname.split('/').filter(Boolean)[0] || '';
    const handle = normalizeHandle(first);
    if (!handle || RESERVED_IG_PATHS.has(handle) || !/^[a-z0-9._]{2,30}$/i.test(handle)) return '';
    return handle;
  } catch { return ''; }
}
function instagramHandleFromText(value) {
  const text = clean(value);
  const explicit = text.match(/@([a-z0-9._]{2,30})\b/i)?.[1];
  return explicit ? normalizeHandle(explicit) : '';
}
function canonicalProfileUrl(handle) {
  const value = normalizeHandle(handle);
  return value ? `https://www.instagram.com/${value}/` : '';
}

function parseFollowerCount(value) {
  const text = clean(value).toLowerCase();
  const match = text.match(/([0-9][0-9,.]*)\s*(k|m|million|lakh|lakhs|crore|crores)?\s+followers?\b/i);
  if (!match) return null;
  const base = Number(String(match[1]).replace(/,/g, ''));
  if (!Number.isFinite(base)) return null;
  const unit = String(match[2] || '').toLowerCase();
  const multiplier = unit === 'k' ? 1e3 : unit === 'm' || unit === 'million' ? 1e6 : unit.startsWith('lakh') ? 1e5 : unit.startsWith('crore') ? 1e7 : 1;
  return Math.round(base * multiplier);
}

function marketEvidence(text, market = DEFAULT_MARKET) {
  const haystack = clean(text).toLowerCase();
  const city = DEFAULT_CITIES.find((item) => haystack.includes(item.toLowerCase())) || null;
  const india = /\b(?:india|indian|bharat)\b/i.test(haystack) || Boolean(city);
  const expectedIndia = /india/i.test(String(market || ''));
  if (!expectedIndia) return { matches: true, confidence: 0.5, evidence: [], city };
  if (city) return { matches: true, confidence: 0.95, evidence: [`city:${city}`], city };
  if (india) return { matches: true, confidence: 0.82, evidence: ['country:India'], city: null };
  return { matches: false, confidence: 0.35, evidence: ['india-scoped-search-only'], city: null };
}

function nicheTokens(niche) {
  return clean(niche).toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3);
}
function nicheScore(text, niche) {
  const tokens = nicheTokens(niche);
  if (!tokens.length) return 0.5;
  const haystack = clean(text).toLowerCase();
  const hits = tokens.filter((token) => haystack.includes(token)).length;
  return Math.min(1, hits / Math.max(1, tokens.length));
}

function extractCandidate(result, context = {}) {
  const url = clean(result?.url);
  const text = clean(`${result?.title || ''} ${result?.snippet || ''} ${url}`);
  const handle = instagramHandleFromUrl(url) || instagramHandleFromText(text);
  if (!handle) return null;
  const market = marketEvidence(text, context.market || DEFAULT_MARKET);
  const nicheFit = nicheScore(text, context.niche || '');
  const followers = parseFollowerCount(text);
  let score = 20; // usable direct/social identity
  score += Math.round(market.confidence * 35);
  score += Math.round(nicheFit * 25);
  if (followers != null) score += 8;
  if (instagramHandleFromUrl(url)) score += 7;
  score = Math.min(100, score);
  return {
    id: `instagram:${handle}`,
    handle,
    platform: 'instagram',
    profileUrl: canonicalProfileUrl(handle),
    displayName: clean(result?.title).replace(/\s*[-|•].*$/, '').slice(0, 120) || null,
    niche: clean(context.niche) || null,
    market: market.matches ? (context.market || DEFAULT_MARKET) : null,
    city: market.city,
    marketConfidence: market.confidence,
    marketEvidence: market.evidence,
    nicheFit,
    followerCount: followers,
    followerCountSource: followers == null ? null : 'public-search-snippet',
    fitScore: score,
    source: clean(result?.source || result?.siteName || 'public-web'),
    sourceUrl: url || null,
    sourceTitle: clean(result?.title) || null,
    sourceSnippet: clean(result?.snippet).slice(0, 500) || null,
    evidenceCapturedAt: new Date().toISOString(),
    outreachState: 'not_contacted',
    firstDmMode: 'manual-first-contact',
  };
}

function dedupe(candidates = []) {
  const map = new Map();
  for (const candidate of candidates) {
    if (!candidate?.handle) continue;
    const key = normalizeHandle(candidate.handle);
    const previous = map.get(key);
    if (!previous || Number(candidate.fitScore || 0) > Number(previous.fitScore || 0)) map.set(key, candidate);
    else if (previous && candidate.sourceUrl && previous.sourceUrl !== candidate.sourceUrl) {
      previous.additionalEvidence = [...new Set([...(previous.additionalEvidence || []), candidate.sourceUrl])].slice(0, 5);
    }
  }
  return [...map.values()].sort((a, b) => Number(b.fitScore || 0) - Number(a.fitScore || 0));
}

function requestFromText(text = '') {
  const value = clean(text);
  const count = Math.max(5, Math.min(50, Number(value.match(/\b(\d{1,2})\s+(?:india(?:n)?\s+)?(?:content\s+)?(?:creators?|influencers?|prospects?|leads?)\b/i)?.[1] || DEFAULT_LIMIT)));
  const nichePatterns = [
    'fitness', 'health', 'nutrition', 'business', 'finance', 'marketing', 'education', 'self improvement', 'self-improvement', 'tech', 'ai', 'software', 'design', 'video editing', 'photography', 'fashion', 'beauty', 'travel', 'food', 'gaming', 'lifestyle', 'motivation', 'career', 'startup', 'entrepreneurship',
  ];
  const niche = nichePatterns.find((item) => new RegExp(`\\b${item.replace(/[- ]/g, '[- ]')}\\b`, 'i').test(value)) || clean(value.match(/\b(?:find|research|discover|source|identify)\s+(?:me\s+)?(?:\d+\s+)?([a-z][a-z &/-]{2,30}?)\s+(?:creators?|influencers?)/i)?.[1]);
  const explicitCities = DEFAULT_CITIES.filter((city) => new RegExp(`\\b${city.replace(/\s+/g, '\\s+')}\\b`, 'i').test(value));
  return {
    market: /\b(?:global|worldwide|international|outside india)\b/i.test(value) ? 'global' : DEFAULT_MARKET,
    niche: niche || 'content creator',
    limit: count,
    cities: explicitCities.length ? explicitCities : DEFAULT_CITIES.slice(0, 8),
  };
}

function buildQueries({ market = DEFAULT_MARKET, niche = 'content creator', cities = DEFAULT_CITIES } = {}) {
  const safeNiche = clean(niche) || 'content creator';
  const safeMarket = clean(market) || DEFAULT_MARKET;
  if (!/india/i.test(safeMarket)) {
    return [
      `site:instagram.com ${safeNiche} creator influencer`,
      `site:instagram.com ${safeNiche} Instagram creator`,
      `${safeNiche} creator Instagram profile`,
    ];
  }
  const cityBatchA = cities.slice(0, 4).join(' OR ');
  const cityBatchB = cities.slice(4, 8).join(' OR ');
  return [
    `site:instagram.com ${safeNiche} Indian creator India Instagram`,
    `site:instagram.com ${safeNiche} creator (${cityBatchA || 'Mumbai OR Delhi OR Bengaluru OR Kolkata'})`,
    `site:instagram.com ${safeNiche} influencer (${cityBatchB || 'Hyderabad OR Chennai OR Pune OR Ahmedabad'})`,
    `Indian ${safeNiche} content creator Instagram @`,
    `site:afluencer.com India ${safeNiche} influencer creator`,
  ];
}

async function searchPublic(query, limit = 10) {
  try {
    const result = await web.searchWeb(query, { limit: Math.min(10, Math.max(3, limit)) });
    return { provider: result.provider || 'tinyfish-search', results: result.results || [] };
  } catch (primaryError) {
    const fallback = await turboResearch.fallbackSearch(query, { limit: Math.min(10, Math.max(3, limit)) });
    return { provider: fallback.provider || 'tavily-fallback', results: fallback.results || [], primaryError: primaryError.message };
  }
}

function loadStore() {
  const value = readJson(STORE_PATH, { version: 1, updatedAt: null, leads: [] });
  return { version: 1, updatedAt: value.updatedAt || null, leads: Array.isArray(value.leads) ? value.leads : [] };
}
function saveLeads(candidates = []) {
  const store = loadStore();
  const byId = new Map(store.leads.map((lead) => [lead.id, lead]));
  for (const candidate of candidates) {
    const previous = byId.get(candidate.id) || {};
    byId.set(candidate.id, {
      ...previous,
      ...candidate,
      firstSeenAt: previous.firstSeenAt || new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      outreachState: previous.outreachState || candidate.outreachState || 'not_contacted',
      notes: previous.notes || '',
    });
  }
  const value = { version: 1, updatedAt: new Date().toISOString(), leads: [...byId.values()] };
  writeJsonAtomic(STORE_PATH, value);
  return value;
}

async function discover(options = {}) {
  const request = {
    market: clean(options.market || DEFAULT_MARKET),
    niche: clean(options.niche || 'content creator'),
    limit: Math.max(5, Math.min(50, Number(options.limit || DEFAULT_LIMIT))),
    cities: Array.isArray(options.cities) && options.cities.length ? options.cities.map(clean).filter(Boolean) : DEFAULT_CITIES.slice(0, 8),
  };
  const queries = buildQueries(request);
  const packets = [];
  const errors = [];
  for (const query of queries) {
    try { packets.push({ query, ...(await searchPublic(query, 10)) }); }
    catch (error) { errors.push({ query, error: error.message }); }
    if (packets.flatMap((packet) => packet.results || []).length >= request.limit * 3) break;
  }
  const candidates = dedupe(packets.flatMap((packet) => (packet.results || []).map((result) => extractCandidate(result, request)).filter(Boolean)))
    .filter((candidate) => request.market.toLowerCase() !== 'india' || candidate.marketConfidence >= 0.35)
    .slice(0, request.limit);
  const store = saveLeads(candidates);
  return {
    ok: candidates.length > 0,
    request,
    candidates,
    count: candidates.length,
    queries: packets.map((packet) => ({ query: packet.query, provider: packet.provider, resultCount: packet.results.length, primaryError: packet.primaryError || null })),
    errors,
    storePath: STORE_PATH,
    totalSavedLeads: store.leads.length,
    policy: {
      publicEvidenceOnly: true,
      inventMetrics: false,
      defaultMarket: DEFAULT_MARKET,
      coldDmMode: 'manual-first-contact',
    },
  };
}

function list(options = {}) {
  let leads = loadStore().leads;
  if (options.market) leads = leads.filter((lead) => clean(lead.market).toLowerCase() === clean(options.market).toLowerCase());
  if (options.niche) leads = leads.filter((lead) => clean(lead.niche).toLowerCase().includes(clean(options.niche).toLowerCase()));
  if (options.outreachState) leads = leads.filter((lead) => lead.outreachState === options.outreachState);
  return leads.sort((a, b) => Number(b.fitScore || 0) - Number(a.fitScore || 0)).slice(0, Math.max(1, Math.min(100, Number(options.limit || 50))));
}

function updateLead(handle, patch = {}) {
  const target = normalizeHandle(handle);
  if (!target) throw new Error('Creator handle is required.');
  const store = loadStore();
  const index = store.leads.findIndex((lead) => normalizeHandle(lead.handle) === target);
  if (index < 0) throw new Error(`Creator @${target} is not in the research lead store.`);
  const allowed = ['outreachState', 'notes', 'lastContactAt', 'nextFollowUpAt', 'dmConversationId', 'dmRecipientId'];
  const safePatch = {};
  for (const key of allowed) if (Object.prototype.hasOwnProperty.call(patch, key)) safePatch[key] = patch[key];
  store.leads[index] = { ...store.leads[index], ...safePatch, updatedAt: new Date().toISOString() };
  store.updatedAt = new Date().toISOString();
  writeJsonAtomic(STORE_PATH, store);
  return store.leads[index];
}

function status() {
  const store = loadStore();
  return {
    implemented: true,
    defaultMarket: DEFAULT_MARKET,
    indiaFirst: /india/i.test(DEFAULT_MARKET),
    defaultLimit: DEFAULT_LIMIT,
    cities: DEFAULT_CITIES,
    savedLeads: store.leads.length,
    publicEvidenceOnly: true,
    dedupe: 'instagram-handle',
    metricsPolicy: 'never-invent; parse only from public evidence',
    firstContactPolicy: 'manual-first-contact; official Instagram API cannot initiate cold conversations',
    providers: { tinyfishPrimary: Boolean(String(process.env.TINYFISH_API_KEY || '').trim()), tavilyFallback: Boolean(String(process.env.TAVILY_API_KEY || '').trim()) },
  };
}

module.exports = {
  STORE_PATH,
  DEFAULT_MARKET,
  DEFAULT_LIMIT,
  DEFAULT_CITIES,
  normalizeHandle,
  instagramHandleFromUrl,
  instagramHandleFromText,
  canonicalProfileUrl,
  parseFollowerCount,
  marketEvidence,
  nicheScore,
  extractCandidate,
  dedupe,
  requestFromText,
  buildQueries,
  searchPublic,
  discover,
  list,
  updateLead,
  status,
};
