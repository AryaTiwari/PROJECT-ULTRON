const fs = require('fs');
const path = require('path');
const config = require('./config');

const APOLLO_MATCH = 'https://api.apollo.io/api/v1/people/match';
const APOLLO_PEOPLE_SEARCH = 'https://api.apollo.io/api/v1/mixed_people/api_search';
const CACHE_FILE = path.join(config.projectRoot, '.ultron', 'lead-enrichment', 'apollo-cache.json');
const CACHE_VERSION = 4;

function envFileValue(name) {
  for (const file of [path.join(config.projectRoot, '.env'), path.join(config.mark3Root, '.env')]) {
    try {
      if (!fs.existsSync(file)) continue;
      const match = fs.readFileSync(file, 'utf8').match(new RegExp(`^\\s*${name}\\s*=\\s*(.*)\\s*$`, 'm'));
      if (match) return String(match[1] || '').trim().replace(/^['"]|['"]$/g, '');
    } catch {}
  }
  return '';
}

function setting(name, fallback = '') {
  return String(process.env[name] || envFileValue(name) || fallback).trim();
}

function normalizeLinkedIn(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  // Office lead sheets often store values such as
  // "ID: https://www.linkedin.com/in/person-name/" rather than a bare URL.
  // Extract the profile URL from surrounding labels/text before normalizing it.
  const embedded = raw.match(/(?:https?:\/\/)?(?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com\/in\/[a-z0-9%._~-]+\/?(?:[?#][^\s<>'"`]*)?/i)?.[0];
  let value = (embedded || raw).replace(/[),.;!?]+$/, '');
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;

  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^(?:[a-z]{2,3}\.)?www\./, '').replace(/^[a-z]{2,3}\./, '');
    if (host !== 'linkedin.com') return null;
    const match = url.pathname.match(/^\/in\/([^/]+)/i);
    if (!match?.[1]) return null;
    const slug = decodeURIComponent(match[1]).trim().replace(/\/+$/, '');
    if (!slug) return null;
    return `https://www.linkedin.com/in/${encodeURIComponent(slug).replace(/%2D/gi, '-').replace(/%5F/gi, '_').replace(/%2E/gi, '.')}`;
  } catch {
    return null;
  }
}

function migrateCache(parsed) {
  const version = Number(parsed?.version || 0);
  if (version === CACHE_VERSION) return { version: CACHE_VERSION, people: parsed.people || {} };

  const people = {};
  for (const [url, record] of Object.entries(parsed?.people || {})) {
    if (!record) continue;

    if (version === 2 || version === 3) {
      if (!record.ambiguous) people[url] = record;
      continue;
    }

    if (record.noMatch === false && record.apolloPersonId) people[url] = record;
  }
  return { version: CACHE_VERSION, people };
}

function readCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return { version: CACHE_VERSION, people: {} };
    return migrateCache(JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')));
  } catch {
    return { version: CACHE_VERSION, people: {} };
  }
}

function saveCache(cache) {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify({ version: CACHE_VERSION, people: cache.people || {} }, null, 2));
}

function numericSetting(name, fallback) {
  const value = Number(setting(name, String(fallback)));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function cacheDays(record) {
  // Positive data is expensive to reveal again, especially mobile numbers. Keep it
  // much longer than negatives. Pending/ambiguous records are intentionally short-lived
  // so quality does not get frozen merely to save credits.
  if (record?.phoneStatus === 'found' || record?.phone || record?.email) {
    return numericSetting('ULTRON_M3_APOLLO_POSITIVE_CACHE_DAYS', 180);
  }
  if (record?.phoneStatus === 'pending') {
    return numericSetting('ULTRON_M3_APOLLO_PENDING_CACHE_DAYS', 1);
  }
  if (record?.ambiguous) {
    return numericSetting('ULTRON_M3_APOLLO_AMBIGUOUS_CACHE_DAYS', 7);
  }
  if (record?.noMatch || record?.emailKnown || record?.phoneStatus === 'not_found') {
    return numericSetting('ULTRON_M3_APOLLO_NEGATIVE_CACHE_DAYS', 30);
  }
  return numericSetting('ULTRON_M3_APOLLO_CACHE_DAYS', 30);
}

function isFresh(record) {
  const checked = Date.parse(record?.checkedAt || '');
  return Number.isFinite(checked) && Date.now() - checked < cacheDays(record) * 86400000;
}

function satisfies(record, { needEmail, needPhone }) {
  if (!record || !isFresh(record)) return false;
  if (record.noMatch || record.ambiguous) return true;
  if (needEmail && !record.emailKnown) return false;
  if (needPhone && !['found', 'not_found', 'pending'].includes(record.phoneStatus)) return false;
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(response, attempt) {
  const retryAfter = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(30_000, retryAfter * 1000);
  return Math.min(12_000, 800 * (2 ** attempt));
}

function webhookUrl() {
  const raw = setting('APOLLO_WEBHOOK_URL');
  const secret = setting('APOLLO_WEBHOOK_SECRET');
  if (!raw || !secret) return '';
  const url = new URL(raw);
  url.searchParams.set('token', secret);
  return url.toString();
}

function workerUrl(pathname) {
  const raw = setting('APOLLO_WEBHOOK_URL');
  const secret = setting('APOLLO_WEBHOOK_SECRET');
  if (!raw || !secret) return '';
  const source = new URL(raw);
  const url = new URL(pathname, source.origin);
  url.searchParams.set('token', secret);
  return url.toString();
}

function validEmail(value) {
  const text = String(value || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? text : null;
}

function normalizedWords(value) {
  return String(value || '').toLowerCase().replace(/\b(?:private|pvt|limited|ltd|llp|plc|inc|incorporated|corp|corporation|company|co)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function hostname(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return raw.toLowerCase().replace(/^www\./, '').split('/')[0];
  }
}

function decisionPriority(title, mode = 'general') {
  const value = normalizedWords(title);
  if (mode === 'hiring') {
    if (/\b(?:head|director|vp|vice president)\b.*\b(?:talent acquisition|recruitment|human resources|hr|people)\b/.test(value)
        || /\b(?:talent acquisition|recruitment|human resources|hr|people)\b.*\b(?:head|director|vp|vice president)\b/.test(value)) return 1;
    if (/\b(?:talent acquisition manager|recruitment manager|recruiting manager|hiring manager|hr manager|human resources manager|people operations manager|people ops manager)\b/.test(value)) return 2;
    if (/\b(?:senior recruiter|technical recruiter|hr recruiter|human resources recruiter|recruiter|talent acquisition|recruitment lead|talent lead|hr business partner|hrbp)\b/.test(value)) return 3;
    if (/\b(?:founder|co founder|owner|chief executive officer|ceo|managing director|director)\b/.test(value)) return 4;
    return 99;
  }
  if (/\b(?:founder|co founder|owner|director|managing director)\b/.test(value)) return 1;
  if (/\b(?:manager|head|talent acquisition lead|recruitment lead)\b/.test(value)) return 2;
  if (/\b(?:hr recruiter|human resources recruiter|recruiter|talent acquisition)\b/.test(value)) return 3;
  return 99;
}

function sameOrganization(person, company, domain = '') {
  const expectedDomain = hostname(domain);
  const actualDomain = hostname(person?.organization?.website_url || person?.organization?.primary_domain || person?.organization?.domain || '');
  if (expectedDomain && actualDomain && (actualDomain === expectedDomain || actualDomain.endsWith(`.${expectedDomain}`) || expectedDomain.endsWith(`.${actualDomain}`))) return true;
  const expected = normalizedWords(company);
  const actual = normalizedWords(person?.organization_name || person?.organization?.name || person?.employment_history?.[0]?.organization_name || '');
  if (!expected || !actual) return false;
  return expected === actual || expected.includes(actual) || actual.includes(expected);
}

function rankedDecisionMakers(people, company, domain = '', priorityMode = 'general') {
  return (Array.isArray(people) ? people : [])
    .filter((person) => sameOrganization(person, company, domain))
    .map((person) => ({
      ...person,
      decisionPriority: decisionPriority(person.title || person.headline || '', priorityMode),
      linkedinUrl: normalizeLinkedIn(person.linkedin_url || person.linkedin || ''),
    }))
    .filter((person) => person.decisionPriority < 99 && person.linkedinUrl)
    .sort((a, b) => a.decisionPriority - b.decisionPriority || String(a.name || '').localeCompare(String(b.name || '')));
}

async function searchCompanyDecisionMaker({ company, domain = '', location = '', priorityMode = 'general' } = {}) {
  const apiKey = setting('APOLLO_API_KEY');
  if (!apiKey) {
    const error = new Error('APOLLO_API_KEY is missing.');
    error.code = 'APOLLO_NOT_CONFIGURED';
    throw error;
  }
  const url = new URL(APOLLO_PEOPLE_SEARCH);
  const titles = priorityMode === 'hiring'
    ? [
      'head of talent acquisition', 'talent acquisition director', 'head of recruitment', 'recruitment director',
      'head of HR', 'HR director', 'human resources director', 'head of people',
      'talent acquisition manager', 'recruitment manager', 'recruiting manager', 'hiring manager', 'HR manager',
      'senior recruiter', 'technical recruiter', 'HR recruiter', 'recruiter', 'talent acquisition',
      'founder', 'co-founder', 'owner', 'managing director',
    ]
    : [
      'founder', 'co-founder', 'owner', 'director', 'managing director',
      'manager', 'head recruiter', 'hiring manager', 'recruitment manager', 'talent acquisition head',
      'HR recruiter', 'human resources recruiter', 'recruiter',
    ];
  const seniorities = priorityMode === 'hiring'
    ? ['head', 'director', 'vp', 'manager', 'owner', 'founder']
    : ['owner', 'founder', 'head', 'director', 'manager'];
  for (const title of titles) url.searchParams.append('person_titles[]', title);
  for (const seniority of seniorities) url.searchParams.append('person_seniorities[]', seniority);
  const cleanDomain = hostname(domain);
  if (cleanDomain) url.searchParams.append('q_organization_domains_list[]', cleanDomain);
  else url.searchParams.set('q_keywords', String(company || '').trim());
  if (location) url.searchParams.append('person_locations[]', String(location).trim());
  url.searchParams.set('include_similar_titles', 'true');
  url.searchParams.set('page', '1');
  url.searchParams.set('per_page', '25');

  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(url, { method: 'POST', headers: { 'x-api-key': apiKey, Accept: 'application/json', 'Cache-Control': 'no-cache' } });
    const text = await response.text();
    let data = {};
    try { data = JSON.parse(text); } catch {}
    if (response.ok) {
      const ranked = rankedDecisionMakers(data.people || data.contacts || [], company, cleanDomain, priorityMode);
      return { ok: true, company, domain: cleanDomain, candidate: ranked[0] || null, candidatesChecked: Array.isArray(data.people) ? data.people.length : 0 };
    }
    const message = data?.error || data?.error_message || data?.message || `Apollo people search failed (${response.status}).`;
    const error = new Error(typeof message === 'string' ? message : JSON.stringify(message));
    error.status = response.status;
    error.code = response.status === 403 ? 'APOLLO_PEOPLE_SEARCH_ACCESS_REQUIRED' : 'APOLLO_PEOPLE_SEARCH_FAILED';
    lastError = error;
    if (response.status !== 429 && response.status < 500) throw error;
    if (attempt < 3) await sleep(retryDelay(response, attempt));
  }
  throw lastError || new Error('Apollo people search failed.');
}

function personFromResponse(data) {
  return data?.person || data?.contact || null;
}

function matchDecision(requestedLinkedIn, data) {
  const person = personFromResponse(data);
  const confidence = String(data?.match_confidence || person?.match_confidence || '').toLowerCase();
  if (!person?.id || confidence === 'none') return { state: 'no_match', confidence, person: person || null };

  const returned = normalizeLinkedIn(person.linkedin_url || person.linkedin || '');
  if (confidence !== 'low' || !returned || returned === requestedLinkedIn) {
    return { state: 'accepted', confidence, person, returnedLinkedIn: returned || null };
  }

  return { state: 'ambiguous', confidence, person, returnedLinkedIn: returned };
}

async function apiCall(linkedinUrl, { needPhone }) {
  const apiKey = setting('APOLLO_API_KEY');
  if (!apiKey) {
    const error = new Error('APOLLO_API_KEY is missing.');
    error.code = 'APOLLO_NOT_CONFIGURED';
    throw error;
  }
  const url = new URL(APOLLO_MATCH);
  url.searchParams.set('linkedin_url', linkedinUrl);
  // Credit-saver defaults: do not run personal-email or waterfall enrichment here.
  // The office Sheet/post itself is checked first by the lead operator.
  url.searchParams.set('reveal_personal_emails', 'false');
  url.searchParams.set('run_waterfall_email', 'false');
  url.searchParams.set('run_waterfall_phone', 'false');
  url.searchParams.set('reveal_phone_number', needPhone ? 'true' : 'false');
  if (needPhone) {
    const callback = webhookUrl();
    if (!callback) {
      const error = new Error('Apollo phone enrichment needs APOLLO_WEBHOOK_URL and APOLLO_WEBHOOK_SECRET.');
      error.code = 'APOLLO_WEBHOOK_NOT_CONFIGURED';
      throw error;
    }
    url.searchParams.set('webhook_url', callback);
  }

  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      },
    });
    const text = await response.text();
    let data = {};
    try { data = JSON.parse(text); } catch {}
    if (response.ok) return data;
    const message = data?.error || data?.error_message || data?.message || `Apollo enrichment failed (${response.status}).`;
    const error = new Error(typeof message === 'string' ? message : JSON.stringify(message));
    error.status = response.status;
    lastError = error;
    if (response.status !== 429 && response.status < 500) throw error;
    if (attempt < 3) await sleep(retryDelay(response, attempt));
  }
  throw lastError || new Error('Apollo enrichment failed.');
}

async function enrich(input, options = {}) {
  const linkedinUrl = normalizeLinkedIn(input);
  if (!linkedinUrl) return { ok: false, invalidLinkedIn: true, linkedinUrl: null };
  const needEmail = Boolean(options.needEmail);
  const needPhone = Boolean(options.needPhone);
  const cache = readCache();
  const existing = cache.people[linkedinUrl];
  if (!options.force && satisfies(existing, { needEmail, needPhone })) {
    return { ok: true, cached: true, linkedinUrl, ...existing };
  }

  const data = await apiCall(linkedinUrl, { needPhone });
  const decision = matchDecision(linkedinUrl, data);
  const previous = existing || {};
  let record;

  if (decision.state === 'no_match') {
    record = {
      ...previous,
      noMatch: true,
      ambiguous: false,
      apolloPersonId: null,
      emailKnown: needEmail ? true : Boolean(previous.emailKnown),
      email: needEmail ? null : (previous.email ?? null),
      phoneStatus: needPhone ? 'not_found' : (previous.phoneStatus || null),
      phone: needPhone ? null : (previous.phone ?? null),
      matchConfidence: decision.confidence || 'none',
      returnedLinkedIn: null,
      checkedAt: new Date().toISOString(),
    };
  } else if (decision.state === 'ambiguous') {
    record = {
      ...previous,
      noMatch: false,
      ambiguous: true,
      apolloPersonId: null,
      emailKnown: false,
      phoneStatus: null,
      matchConfidence: decision.confidence || '',
      returnedLinkedIn: decision.returnedLinkedIn || null,
      checkedAt: new Date().toISOString(),
    };
  } else {
    const person = decision.person;
    record = {
      ...previous,
      noMatch: false,
      ambiguous: false,
      apolloPersonId: String(person.id),
      emailKnown: needEmail ? true : Boolean(previous.emailKnown),
      email: needEmail ? validEmail(person.email) : (previous.email ?? null),
      phoneStatus: needPhone ? 'pending' : (previous.phoneStatus || null),
      phone: needPhone ? null : (previous.phone ?? null),
      matchConfidence: decision.confidence || '',
      returnedLinkedIn: decision.returnedLinkedIn || null,
      checkedAt: new Date().toISOString(),
      phoneRequestedAt: needPhone ? new Date().toISOString() : (previous.phoneRequestedAt || null),
    };
  }

  cache.people[linkedinUrl] = record;
  saveCache(cache);
  return { ok: true, cached: false, linkedinUrl, ...record };
}

async function fetchPhoneResults() {
  const url = workerUrl('/results');
  if (!url) return [];
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || `Apollo webhook results failed (${response.status}).`);
  return Array.isArray(data.results) ? data.results : [];
}

async function consumePhoneResult(apolloPersonId) {
  const url = workerUrl('/results/consume');
  if (!url) return false;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ apollo_person_id: apolloPersonId }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || `Apollo webhook consume failed (${response.status}).`);
  return true;
}

function recordPhoneResult(apolloPersonId, phone) {
  const id = String(apolloPersonId || '').trim();
  if (!id) return [];
  const cache = readCache();
  const changed = [];
  for (const [linkedinUrl, record] of Object.entries(cache.people)) {
    if (String(record?.apolloPersonId || '') !== id) continue;
    record.phone = phone ? String(phone).trim() : null;
    record.phoneStatus = record.phone ? 'found' : 'not_found';
    record.phoneResolvedAt = new Date().toISOString();
    record.checkedAt = new Date().toISOString();
    changed.push(linkedinUrl);
  }
  if (changed.length) saveCache(cache);
  return changed;
}

function status() {
  return {
    apiKeyReady: Boolean(setting('APOLLO_API_KEY')),
    webhookReady: Boolean(setting('APOLLO_WEBHOOK_URL') && setting('APOLLO_WEBHOOK_SECRET')),
    peopleSearchReady: Boolean(setting('APOLLO_API_KEY')),
    companySearchMax: Math.max(1, Math.min(100, numericSetting('ULTRON_M3_APOLLO_COMPANY_SEARCH_MAX', 50))),
    decisionMakerPriority: {
      general: ['director/founder/owner', 'manager/head recruiter', 'HR recruiter'],
      hiring: ['talent/HR head or director', 'talent/recruitment/HR manager', 'recruiter/talent acquisition', 'founder/owner fallback'],
    },
    cacheFile: CACHE_FILE,
    positiveCacheDays: numericSetting('ULTRON_M3_APOLLO_POSITIVE_CACHE_DAYS', 180),
    negativeCacheDays: numericSetting('ULTRON_M3_APOLLO_NEGATIVE_CACHE_DAYS', 30),
  };
}

module.exports = {
  setting,
  normalizeLinkedIn,
  matchDecision,
  decisionPriority,
  sameOrganization,
  rankedDecisionMakers,
  searchCompanyDecisionMaker,
  readCache,
  saveCache,
  cacheDays,
  status,
  enrich,
  fetchPhoneResults,
  consumePhoneResult,
  recordPhoneResult,
};
