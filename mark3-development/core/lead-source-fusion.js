const SERP_ENDPOINT = 'https://serpapi.com/search.json';
const APIFY_BASE = 'https://api.apify.com/v2';
const DEFAULT_MAPS_ACTOR = 'compass~crawler-google-places';

const INDIAN_LOCATIONS = [
  'Mumbai','Delhi','New Delhi','Bengaluru','Bangalore','Kolkata','Hyderabad','Chennai','Pune','Ahmedabad','Jaipur','Surat',
  'Chandigarh','Lucknow','Indore','Kochi','Gurugram','Gurgaon','Noida','Navi Mumbai','Thane','Bhubaneswar','Coimbatore',
  'Vadodara','Nagpur','Patna','Ranchi','Dehradun','Visakhapatnam','Mysuru','Mysore','Goa','India',
];

const LOCAL_BUSINESS_TERMS = /\b(?:google\s*maps?|maps?|local businesses?|gyms?|fitness studios?|clinics?|hospitals?|dentists?|doctors?|salons?|spas?|restaurants?|cafes?|hotels?|agencies|agency|consultancies|consultancy|real estate|realtors?|shops?|stores?|coaching|institutes?|schools?|colleges?|dietitians?|nutritionists?|law firms?|accountants?|coworking|studios?|photographers?|wedding planners?)\b/i;
const HIRING_TERMS = /\b(?:jobs?|hiring|vacanc(?:y|ies)|recruit(?:er|ers|ment|ing)?|talent acquisition|staffing|hr\b|human resources|naukri|indeed|apna|workindia|google jobs?)\b/i;

function serpApiKey() {
  return String(process.env.SERP_API_KEY || process.env.SERPAPI_API_KEY || '').trim();
}

function apifyApiKey() {
  return String(process.env.APIFY_API_KEY || process.env.APIFY_API_TOKEN || '').trim();
}

function boundedNumber(name, fallback, min, max) {
  const value = Number(process.env[name]);
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : fallback));
}

function status() {
  return {
    serpApiConfigured: Boolean(serpApiKey()),
    apifyConfigured: Boolean(apifyApiKey()),
    serpGoogleJobs: Boolean(serpApiKey()),
    serpGoogleFallback: Boolean(serpApiKey()),
    apifyGoogleMaps: Boolean(apifyApiKey()),
    apifyActor: String(process.env.APIFY_GOOGLE_MAPS_ACTOR || DEFAULT_MAPS_ACTOR).trim(),
    maxJobSignals: boundedNumber('ULTRON_M3_SERP_JOBS_MAX_RESULTS', 18, 3, 40),
    maxMapPlaces: boundedNumber('ULTRON_M3_APIFY_MAPS_MAX_PLACES', 12, 3, 30),
  };
}

function detectLocation(text) {
  const value = String(text || '');
  for (const location of INDIAN_LOCATIONS) {
    if (new RegExp(`\\b${location.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`, 'i').test(value)) {
      return /india/i.test(location) ? 'India' : `${location}, India`;
    }
  }
  return 'India';
}

function sourcePlan(originalMessage, criteria) {
  const text = `${originalMessage || ''} ${criteria || ''}`;
  const explicitMaps = /\b(?:google\s*maps?|maps?)\b/i.test(text);
  const explicitJobs = /\b(?:google jobs?|naukri|indeed|apna|workindia|job platforms?|job boards?)\b/i.test(text);
  return {
    location: detectLocation(text),
    useJobs: Boolean(serpApiKey() && (explicitJobs || HIRING_TERMS.test(text))),
    useMaps: Boolean(apifyApiKey() && (explicitMaps || LOCAL_BUSINESS_TERMS.test(text))),
    explicitJobs,
    explicitMaps,
  };
}

async function fetchJson(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(3000, timeoutMs));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
    if (!response.ok) {
      const message = data?.error?.message || data?.error || data?.message || String(raw || '').slice(0, 600) || `HTTP ${response.status}`;
      const error = new Error(String(message));
      error.status = response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') {
      const timeoutError = new Error(`Lead source request timed out after ${timeoutMs}ms.`);
      timeoutError.code = 'LEAD_SOURCE_TIMEOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function serpSearch(query, options = {}) {
  const key = serpApiKey();
  if (!key) throw new Error('SERP_API_KEY is not configured.');
  const params = new URLSearchParams({
    engine: 'google',
    q: String(query || '').trim(),
    api_key: key,
    hl: 'en',
    gl: 'in',
    num: String(Math.max(1, Math.min(10, Number(options.limit || 10)))),
  });
  const data = await fetchJson(`${SERP_ENDPOINT}?${params}`, {}, Math.max(5000, Number(options.timeoutMs || 15000)));
  const results = (Array.isArray(data?.organic_results) ? data.organic_results : []).map((item, index) => ({
    position: Number(item?.position || index + 1),
    title: String(item?.title || '').trim(),
    snippet: String(item?.snippet || '').trim(),
    url: String(item?.link || '').trim(),
    siteName: String(item?.source || item?.displayed_link || '').trim(),
  })).filter((item) => item.url);
  if (!results.length) throw new Error('SerpApi returned no organic results.');
  return { query: String(query || '').trim(), results, provider: 'serpapi-google' };
}

async function googleJobs(criteria, options = {}) {
  const key = serpApiKey();
  if (!key) return [];
  const max = Math.max(1, Math.min(status().maxJobSignals, Number(options.limit || status().maxJobSignals)));
  const params = new URLSearchParams({
    engine: 'google_jobs',
    q: String(criteria || '').trim(),
    api_key: key,
    hl: 'en',
    gl: 'in',
    location: String(options.location || detectLocation(criteria)),
  });
  const data = await fetchJson(`${SERP_ENDPOINT}?${params}`, {}, Math.max(7000, Number(options.timeoutMs || 18000)));
  return (Array.isArray(data?.jobs_results) ? data.jobs_results : []).slice(0, max).map((job) => ({
    title: String(job?.title || '').trim(),
    company: String(job?.company_name || '').trim(),
    location: String(job?.location || '').trim(),
    via: String(job?.via || '').trim(),
    description: String(job?.description || '').replace(/\s+/g, ' ').trim().slice(0, 900),
    jobId: String(job?.job_id || '').trim(),
    source: 'serpapi-google-jobs',
  })).filter((job) => job.company);
}

async function apifyGoogleMaps(criteria, options = {}) {
  const token = apifyApiKey();
  if (!token) return [];
  const max = Math.max(1, Math.min(status().maxMapPlaces, Number(options.limit || status().maxMapPlaces)));
  const actor = String(process.env.APIFY_GOOGLE_MAPS_ACTOR || DEFAULT_MAPS_ACTOR).trim().replace('/', '~');
  const input = {
    searchStringsArray: [String(criteria || '').trim()],
    locationQuery: String(options.location || detectLocation(criteria)),
    maxCrawledPlacesPerSearch: max,
    language: 'en',
    scrapeSocialMediaProfiles: { facebooks: false, instagrams: false, youtubes: false, tiktoks: false, twitters: false },
    maximumLeadsEnrichmentRecords: 0,
    maxCompetitorsToAnalyze: 0,
  };
  const params = new URLSearchParams({ clean: 'true', format: 'json' });
  const url = `${APIFY_BASE}/actors/${encodeURIComponent(actor)}/run-sync-get-dataset-items?${params}`;
  const data = await fetchJson(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(input),
  }, Math.max(20000, Number(options.timeoutMs || 120000)));
  const items = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
  return items.slice(0, max).map((place) => ({
    company: String(place?.title || place?.name || '').trim(),
    category: String(place?.categoryName || place?.category || '').trim(),
    address: String(place?.address || '').trim(),
    website: String(place?.website || '').trim(),
    phone: String(place?.phone || place?.phoneUnformatted || '').trim(),
    rating: Number(place?.totalScore || place?.rating || 0) || null,
    reviews: Number(place?.reviewsCount || place?.reviews || 0) || null,
    mapsUrl: String(place?.url || place?.placeUrl || '').trim(),
    source: 'apify-google-maps',
  })).filter((place) => place.company);
}

function normalizeCompany(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(?:private|pvt|limited|ltd|llp|inc|corp|corporation|company|co)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function companyMatches(a, b) {
  const A = normalizeCompany(a);
  const B = normalizeCompany(b);
  if (!A || !B) return false;
  if (A === B) return true;
  if (A.length >= 6 && B.includes(A)) return true;
  if (B.length >= 6 && A.includes(B)) return true;
  const aTokens = new Set(A.split(' ').filter((x) => x.length >= 3));
  const bTokens = new Set(B.split(' ').filter((x) => x.length >= 3));
  if (!aTokens.size || !bTokens.size) return false;
  let common = 0;
  for (const token of aTokens) if (bTokens.has(token)) common++;
  return common >= Math.min(2, Math.min(aTokens.size, bTokens.size));
}

function uniqueCompanies(items) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    const key = normalizeCompany(item.company);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function seedQueries(signals, criteria, count = 25) {
  const queries = [];
  const maxCompanies = Math.min(10, Math.max(4, Math.ceil(Number(count || 25) / 20) + 4));
  for (const job of uniqueCompanies(signals?.jobs).slice(0, maxCompanies)) {
    const company = job.company.replace(/"/g, '');
    queries.push(`site:linkedin.com/in "${company}" recruiter`);
    queries.push(`site:linkedin.com/in "${company}" "talent acquisition"`);
  }
  for (const place of uniqueCompanies(signals?.maps).slice(0, maxCompanies)) {
    const company = place.company.replace(/"/g, '');
    queries.push(`site:linkedin.com/in "${company}" founder OR owner`);
    queries.push(`site:linkedin.com/in "${company}" marketing manager`);
  }
  if (signals?.plan?.explicitJobs) {
    queries.push(`site:naukri.com ${criteria}`);
    queries.push(`site:in.indeed.com ${criteria}`);
    queries.push(`site:apna.co ${criteria}`);
    queries.push(`site:workindia.in ${criteria}`);
  }
  return [...new Set(queries.map((q) => q.replace(/\s+/g, ' ').trim()))].slice(0, 24);
}

function mergeQueries(baseQueries, signals, criteria, count) {
  const source = seedQueries(signals, criteria, count);
  return [...new Set([...source, ...(baseQueries || [])])].slice(0, 48);
}

function annotateLead(lead, signals) {
  const evidence = [];
  const jobs = (signals?.jobs || []).filter((job) => companyMatches(lead?.company, job.company));
  const maps = (signals?.maps || []).filter((place) => companyMatches(lead?.company, place.company));
  if (jobs.length) evidence.push('google-jobs');
  if (maps.length) evidence.push('google-maps');
  const hiring = jobs[0] || null;
  const map = maps[0] || null;
  return {
    sourceCount: evidence.length,
    evidence,
    boost: Math.min(20, jobs.length ? 12 : 0) + Math.min(10, maps.length ? 8 : 0),
    hiringSignal: hiring ? `${hiring.title}${hiring.via ? ` via ${hiring.via}` : ''}${hiring.location ? ` · ${hiring.location}` : ''}` : '',
    mapSignal: map ? `${map.category || 'Google Maps business'}${map.rating ? ` · ${map.rating}/5` : ''}${map.reviews ? ` · ${map.reviews} reviews` : ''}` : '',
    signalWebsite: map?.website || '',
    signalPhone: map?.phone || '',
  };
}

async function gatherSources(input = {}) {
  const criteria = String(input.criteria || '').trim();
  const originalMessage = String(input.originalMessage || criteria);
  const plan = sourcePlan(originalMessage, criteria);
  const errors = [];
  let jobs = [];
  let maps = [];

  if (plan.useJobs) {
    try { jobs = await googleJobs(criteria, { location: plan.location, limit: input.jobLimit }); }
    catch (error) { errors.push({ source: 'serpapi-google-jobs', error: error.message }); }
  }
  if (plan.useMaps) {
    try { maps = await apifyGoogleMaps(criteria, { location: plan.location, limit: input.mapLimit }); }
    catch (error) { errors.push({ source: 'apify-google-maps', error: error.message }); }
  }

  const platforms = [...new Set(jobs.map((job) => job.via).filter(Boolean))];
  const result = {
    completed: true,
    plan,
    jobs,
    maps,
    jobCompanies: uniqueCompanies(jobs).length,
    mapBusinesses: uniqueCompanies(maps).length,
    platforms,
    errors,
    gatheredAt: new Date().toISOString(),
  };
  result.seedQueries = seedQueries(result, criteria, input.count);
  return result;
}

function summary(signals) {
  if (!signals) return 'Source fusion not run.';
  const parts = [];
  if (signals.plan?.useJobs) parts.push(`Google Jobs ${signals.jobs?.length || 0} signals${signals.platforms?.length ? ` via ${signals.platforms.slice(0, 5).join(', ')}` : ''}`);
  if (signals.plan?.useMaps) parts.push(`Google Maps ${signals.maps?.length || 0} businesses`);
  if (!parts.length) parts.push('specialized sources not needed for this request');
  if (signals.errors?.length) parts.push(`${signals.errors.length} source warning${signals.errors.length === 1 ? '' : 's'}`);
  return parts.join('; ');
}

module.exports = {
  status,
  serpApiKey,
  apifyApiKey,
  detectLocation,
  sourcePlan,
  serpSearch,
  googleJobs,
  apifyGoogleMaps,
  normalizeCompany,
  companyMatches,
  uniqueCompanies,
  seedQueries,
  mergeQueries,
  annotateLead,
  gatherSources,
  summary,
};
