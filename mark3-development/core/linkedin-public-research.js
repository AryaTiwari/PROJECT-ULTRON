const web = require('./web');

const SERP_ENDPOINT = 'https://serpapi.com/search.json';

const INDIA_LOCATIONS = [
  'Maharashtra','Karnataka','West Bengal','Tamil Nadu','Telangana','Gujarat','Rajasthan','Delhi','Uttar Pradesh','Madhya Pradesh',
  'Kerala','Punjab','Haryana','Odisha','Bihar','Jharkhand','Goa','Assam','Chandigarh',
  'Mumbai','Pune','Nagpur','Nashik','Thane','Navi Mumbai','Aurangabad','Bengaluru','Bangalore','Kolkata','Hyderabad','Chennai',
  'Ahmedabad','Jaipur','Surat','Gurugram','Gurgaon','Noida','Lucknow','Indore','Kochi','Bhubaneswar','Coimbatore','Vadodara',
];

function serpApiKey() {
  return String(process.env.SERP_API_KEY || process.env.SERPAPI_API_KEY || '').trim();
}

function boundedNumber(name, fallback, min, max) {
  const value = Number(process.env[name]);
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : fallback));
}

function status() {
  return {
    configured: Boolean(serpApiKey()),
    provider: 'serpapi-google-public-index',
    companyProfiles: true,
    peopleProfiles: true,
    directLinkedInLogin: false,
    sessionCookies: false,
    antiBotBypass: false,
    directPublicFetch: /^(1|true|yes|on)$/i.test(String(process.env.ULTRON_M3_LINKEDIN_DIRECT_PUBLIC_FETCH || '0')),
    maxSearchCalls: boundedNumber('ULTRON_M3_LINKEDIN_MAX_SEARCH_CALLS', 10, 2, 20),
    maxResults: boundedNumber('ULTRON_M3_LINKEDIN_MAX_RESULTS', 120, 10, 200),
  };
}

function regexEscape(value) {
  return String(value || '').replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
}

function locationFromText(text) {
  const value = String(text || '');
  for (const location of [...INDIA_LOCATIONS].sort((a, b) => b.length - a.length)) {
    if (new RegExp('\\b' + regexEscape(location) + '\\b', 'i').test(value)) return location;
  }
  return /\bindia\b/i.test(value) ? 'India' : '';
}

function entityModeFromText(text) {
  const value = String(text || '');
  if (/\b(?:companies|company|business(?:es)?|employers?|organizations?|organisations?|startups?|firms?|agencies)\b/i.test(value)) return 'company';
  return 'person';
}

function plan(originalMessage, criteria = '') {
  const text = String(originalMessage || '') + ' ' + String(criteria || '');
  return {
    enabled: /\blinkedin\b/i.test(text),
    entityMode: entityModeFromText(text),
    location: locationFromText(text),
    hiring: /\b(?:hiring|recruiting|jobs?|vacanc(?:y|ies)|openings?|roles?|professionals? needed|talent)\b/i.test(text),
  };
}

function normalizeLinkedInEntityUrl(input, expectedType = null) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const embedded = raw.match(/(?:https?:\/\/)?(?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com\/(?:in|company)\/[a-z0-9%._~-]+\/?(?:[?#][^\s<>'"`]*)?/i)?.[0];
  let value = String(embedded || raw).replace(/[),.;!?]+$/, '');
  if (!/^https?:\/\//i.test(value)) value = 'https://' + value;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^(?:[a-z]{2,3}\.)?www\./, '').replace(/^[a-z]{2,3}\./, '');
    if (host !== 'linkedin.com') return null;
    const match = url.pathname.match(/^\/(in|company)\/([^/]+)/i);
    if (!match?.[2]) return null;
    const type = match[1].toLowerCase() === 'in' ? 'person' : 'company';
    if (expectedType && type !== expectedType) return null;
    const slug = decodeURIComponent(match[2]).trim().replace(/\/+$/, '');
    if (!slug) return null;
    const path = type === 'person' ? 'in' : 'company';
    const encoded = encodeURIComponent(slug).replace(/%2D/gi, '-').replace(/%5F/gi, '_').replace(/%2E/gi, '.');
    return { type, slug, url: 'https://www.linkedin.com/' + path + '/' + encoded };
  } catch {
    return null;
  }
}

function cleanCriteria(value) {
  return String(value || '')
    .replace(/^(?:hey\s+)?ultron\b[\s,:;.!-]*/i, '')
    .replace(/^(?:find|get|bring|research|source|collect|discover|scrape|build|generate|make)\s+(?:me\s+)?\d{0,4}\s*/i, '')
    .replace(/\b(?:on|from|using|via)\s+linkedin\b/gi, ' ')
    .replace(/\b(?:linkedin\s+)?(?:leads?|prospects?|contacts?|profiles?)\b/gi, ' ')
    .replace(/\b(?:and\s+)?create\s+(?:a\s+)?(?:google\s+)?(?:sheet|spreadsheet)\b[\s\S]*$/i, ' ')
    .replace(/\b(?:with|including)\s+(?:their\s+)?(?:email|phone|mobile|number|contact details?|contact information)(?:\s*(?:and|&|\+)\s*(?:email|phone|mobile|number))?\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function coreTopic(criteria, entityMode) {
  let value = cleanCriteria(criteria)
    .replace(/\b(?:companies|company|business(?:es)?|employers?|organizations?|organisations?|startups?|firms?)\b/gi, ' ')
    .replace(/\b(?:people|persons?|users?|professionals?|recruiters?|founders?|owners?|managers?|employees?)\b/gi, ' ');
  for (const location of [...INDIA_LOCATIONS, 'India'].sort((a, b) => b.length - a.length)) {
    value = value.replace(new RegExp('\\b' + regexEscape(location) + '\\b', 'gi'), ' ');
  }
  value = value
    .replace(/\b(?:those|that|who)\s+(?:are\s+)?(?:currently\s+)?(?:hiring|recruiting)\b/gi, ' ')
    .replace(/\b(?:hiring|recruiting|jobs?|vacanc(?:y|ies)|openings?)\b/gi, ' ')
    .replace(/\b(?:from|in|at|near|around)\b\s*$/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return value || (entityMode === 'company' ? 'companies' : 'professionals');
}

function queryPlan(criteria, count = 25, options = {}) {
  const entityMode = options.entityMode || entityModeFromText(criteria);
  const location = options.location || locationFromText(criteria);
  const hiring = options.hiring ?? /\b(?:hiring|recruiting|jobs?|vacanc(?:y|ies)|openings?)\b/i.test(criteria);
  const topic = coreTopic(criteria, entityMode);
  const site = entityMode === 'company' ? 'site:linkedin.com/company' : 'site:linkedin.com/in';
  const quotedTopic = topic && !/^(?:companies|professionals)$/i.test(topic) ? '"' + topic.replace(/"/g, '') + '"' : topic;
  const loc = location ? '"' + location + '"' : '';
  const variants = [];
  if (entityMode === 'company') {
    if (hiring) {
      variants.push(site + ' ' + quotedTopic + ' ' + loc + ' hiring');
      variants.push(site + ' ' + quotedTopic + ' ' + loc + ' recruiting');
      variants.push(site + ' ' + quotedTopic + ' ' + loc + ' jobs');
    }
    variants.push(site + ' ' + quotedTopic + ' ' + loc);
    variants.push(site + ' ' + loc + ' ' + quotedTopic + ' company');
  } else {
    variants.push(site + ' ' + quotedTopic + ' ' + loc);
    variants.push(site + ' ' + quotedTopic + ' ' + loc + ' professional');
    if (hiring) variants.push(site + ' ' + quotedTopic + ' ' + loc + ' recruiter OR hiring');
  }
  const signalQueries = [];
  for (const company of (options.companyNames || []).slice(0, 12)) {
    const safe = String(company || '').replace(/"/g, '').trim();
    if (safe) signalQueries.push('site:linkedin.com/company "' + safe + '"');
  }
  const desired = Math.min(status().maxSearchCalls, Math.max(3, Math.ceil(Number(count || 25) / 10) + 2));
  const broad = [...new Set(variants.map((q) => q.replace(/\s+/g, ' ').trim()).filter(Boolean))];
  const signals = [...new Set(signalQueries)];
  const broadBudget = Math.min(broad.length, Math.max(2, Math.ceil(desired * 0.6)));
  return [...new Set([
    ...broad.slice(0, broadBudget),
    ...signals,
    ...broad.slice(broadBudget),
  ])].slice(0, desired);
}

async function fetchJson(url, timeoutMs = 18000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(5000, timeoutMs));
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
    if (!response.ok) {
      const error = new Error(String(data?.error || data?.message || raw || ('HTTP ' + response.status)).slice(0, 700));
      error.status = response.status;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function serpPage(query, start = 0, limit = 10) {
  const key = serpApiKey();
  if (!key) throw new Error('SERP_API_KEY is required for LinkedIn public research.');
  const params = new URLSearchParams({ engine: 'google', q: String(query || '').trim(), api_key: key, hl: 'en', gl: 'in', num: String(Math.max(1, Math.min(10, Number(limit || 10)))) });
  if (start > 0) params.set('start', String(start));
  const data = await fetchJson(SERP_ENDPOINT + '?' + params);
  return (Array.isArray(data?.organic_results) ? data.organic_results : []).map((item, index) => ({
    position: Number(item?.position || index + 1 + start),
    title: String(item?.title || '').trim(),
    snippet: String(item?.snippet || '').replace(/\s+/g, ' ').trim(),
    url: String(item?.link || '').trim(),
    displayedLink: String(item?.displayed_link || '').trim(),
  }));
}

function parsePersonTitle(title) {
  const cleaned = String(title || '').replace(/\s*[|•-]\s*LinkedIn\s*$/i, '').trim();
  const parts = cleaned.split(/\s+(?:\||•|–|—|-)+\s+/).map((x) => x.trim()).filter(Boolean);
  let name = parts[0] || '';
  let role = parts[1] || '';
  let company = parts[2] || '';
  const at = role.match(/^(.+?)\s+at\s+(.+)$/i);
  if (at) { role = at[1].trim(); company = company || at[2].trim(); }
  if (/linkedin|profile|jobs?/i.test(name) || name.length > 100) name = '';
  return { name, role, company };
}

function parseCompanyTitle(title, slug) {
  let company = String(title || '').replace(/\s*[|•-]\s*LinkedIn\s*$/i, '').replace(/\s*:\s*Overview\s*$/i, '').trim();
  if (!company || /linkedin/i.test(company)) company = String(slug || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
  return company;
}

function parseResult(item, options = {}) {
  const entity = normalizeLinkedInEntityUrl(item?.url, options.entityMode || null);
  if (!entity) return null;
  const snippet = String(item?.snippet || '').trim();
  if (entity.type === 'company') {
    const company = parseCompanyTitle(item?.title, entity.slug);
    return { entityType: 'company', name: company, company, role: '', linkedin: entity.url, snippet, source: entity.url, location: options.location || locationFromText(snippet), hiringSignal: /\b(?:hiring|recruiting|jobs?|vacanc(?:y|ies)|openings?)\b/i.test(snippet) ? snippet.slice(0, 500) : '', sourceEvidence: ['linkedin-public-index'], sourceCount: 1 };
  }
  const parsed = parsePersonTitle(item?.title);
  return { entityType: 'person', ...parsed, linkedin: entity.url, snippet, source: entity.url, location: options.location || locationFromText(snippet), sourceEvidence: ['linkedin-public-index'], sourceCount: 1 };
}

function publicPageLooksUsable(page) {
  const text = String(page?.text || '');
  if (!text || text.length < 120) return false;
  if (/sign in|join linkedin|authwall|login|checkpoint|security verification/i.test(text.slice(0, 3000))) return false;
  return true;
}

async function maybeFetchPublicPage(record) {
  if (!status().directPublicFetch || !record?.linkedin) return record;
  try {
    const page = await web.fetchPage(record.linkedin, { maxTextChars: 12000, timeoutMs: 12000 });
    if (!publicPageLooksUsable(page)) return record;
    record.publicPageText = page.text.slice(0, 6000);
    record.publicPageFetched = true;
    record.sourceEvidence = [...new Set([...(record.sourceEvidence || []), 'linkedin-public-page'])];
    record.sourceCount = record.sourceEvidence.length;
  } catch {}
  return record;
}

function normalizeCompanyName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(?:private|pvt|limited|ltd|llp|inc|corp|corporation|company|co)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function companySignalMatch(record, companyNames = []) {
  const candidate = normalizeCompanyName(record?.company || record?.name);
  if (!candidate) return false;
  return (companyNames || []).some((name) => {
    const signal = normalizeCompanyName(name);
    return signal && (candidate === signal || candidate.includes(signal) || signal.includes(candidate));
  });
}

function scoreRecord(record, options = {}) {
  let score = 30;
  const haystack = (String(record?.name || '') + ' ' + String(record?.company || '') + ' ' + String(record?.role || '') + ' ' + String(record?.snippet || '')).toLowerCase();
  const topic = coreTopic(options.criteria || '', record.entityType).toLowerCase();
  const tokens = topic.split(/\s+/).filter((x) => x.length >= 3);
  const matched = tokens.filter((token) => haystack.includes(token)).length;
  score += Math.min(30, matched * 6);
  if (options.location && haystack.includes(String(options.location).toLowerCase())) score += 15;
  if (options.hiring && /\b(?:hiring|recruiting|jobs?|vacanc(?:y|ies)|openings?)\b/i.test(record?.snippet || '')) score += 15;
  if (companySignalMatch(record, options.companyNames || [])) score += 25;
  if (record?.linkedin && (record?.name || record?.company)) score += 5;
  return Math.max(0, Math.min(100, score));
}

async function research(criteria, count = 25, options = {}) {
  const mode = options.entityMode || entityModeFromText(criteria);
  const location = options.location || locationFromText(criteria);
  const hiring = options.hiring ?? /\b(?:hiring|recruiting|jobs?|vacanc(?:y|ies)|openings?)\b/i.test(criteria);
  const limit = Math.min(status().maxResults, Math.max(1, Number(count || 25)));
  const queries = queryPlan(criteria, limit, { ...options, entityMode: mode, location, hiring });
  const maxCalls = status().maxSearchCalls;
  const records = [];
  const seen = new Set();
  const failures = [];
  let calls = 0;
  for (const query of queries) {
    if (records.length >= limit || calls >= maxCalls) break;
    const pagesForQuery = Math.min(3, Math.max(1, Math.ceil((limit - records.length) / 10)));
    for (let page = 0; page < pagesForQuery && records.length < limit && calls < maxCalls; page++) {
      try {
        const items = await serpPage(query, page * 10, 10);
        calls++;
        if (!items.length) break;
        for (const item of items) {
          const record = parseResult(item, { entityMode: mode, location });
          if (!record || seen.has(record.linkedin)) continue;
          record.relevanceScore = scoreRecord(record, { criteria, location, hiring, companyNames: options.companyNames || [] });
          if (record.relevanceScore < 50) continue;
          seen.add(record.linkedin);
          records.push(await maybeFetchPublicPage(record));
          if (records.length >= limit) break;
        }
      } catch (error) {
        calls++;
        failures.push({ query, page, error: error.message });
        break;
      }
    }
  }
  return { completed: true, entityMode: mode, location, hiring, requested: limit, found: records.length, searchCalls: calls, queries, failures, records, provider: 'linkedin-public-research', access: status().directPublicFetch ? 'public-index+public-pages-no-login' : 'public-index-only', gatheredAt: new Date().toISOString() };
}

function summary(result) {
  if (!result) return 'LinkedIn public research not run.';
  return 'LinkedIn ' + (result.entityMode || 'public') + ' research ' + (result.found || 0) + '/' + (result.requested || 0) + ' from ' + (result.searchCalls || 0) + ' bounded search calls' + (result.location ? ' · ' + result.location : '');
}

module.exports = { status, plan, locationFromText, entityModeFromText, normalizeLinkedInEntityUrl, cleanCriteria, coreTopic, queryPlan, parseResult, publicPageLooksUsable, normalizeCompanyName, companySignalMatch, scoreRecord, research, summary };
