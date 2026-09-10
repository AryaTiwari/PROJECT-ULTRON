const fs = require('fs');
const path = require('path');
const config = require('./config');
const googleAuth = require('./google-sheets-auth');
const sheets = require('./google-sheets-operator');
const web = require('./web');
const leadResearch = require('./lead-research-operator');
const leadEnrichment = require('./lead-enrichment-operator');
const apollo = require('./apollo-enrichment');

const API = 'https://sheets.googleapis.com/v4/spreadsheets';
const STATE_FILE = path.join(config.projectRoot, '.ultron', 'lead-workspace', 'state.json');
const DEFAULT_HEADERS = ['Name', 'Company', 'Role', 'LinkedIn Profile URL', 'Post Details', 'Phone No', 'Email', 'Source'];
const MAX_LEADS = 200;
const MAX_TEMPLATES = 16;
const PENDING_TTL_MS = 45 * 60 * 1000;
const SEARCH_RETRY_DELAYS = [450, 1200];
const GENERIC_CRITERIA_WORDS = new Set([
  'lead','leads','prospect','prospects','people','person','profiles','profile','contacts','contact',
  'find','get','bring','source','research','discover','collect','build','generate','scrape','make',
  'google','sheet','spreadsheet','with','email','phone','number','mobile','details',
  'and','or','the','a','an','for','of','to','in','on','at','from','me','my','our','new',
]);

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultState() {
  return { version: 2, templates: [], pendingPlan: null, missions: [] };
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return defaultState();
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      version: 2,
      templates: Array.isArray(parsed.templates) ? parsed.templates : [],
      pendingPlan: parsed.pendingPlan || null,
      missions: Array.isArray(parsed.missions) ? parsed.missions : [],
    };
  } catch {
    return defaultState();
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  state.version = 2;
  state.templates = (state.templates || []).slice(-MAX_TEMPLATES);
  state.missions = (state.missions || []).slice(-24);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function normalizeHeader(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[._/\\-]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function keyForHeader(value) {
  const h = normalizeHeader(value);
  if (!h) return null;
  if (/^(?:person or company name|person company name|lead|lead name|contact person)$/.test(h)) return 'name';
  if (/^(?:post details?|post content|post text|job post|job posting|job details?|job description|jd|description|details|content|source text|linkedin post|linkedin post details|requirement details|recruiter post|notes|remarks)$/.test(h)) return 'details';
  const base = leadResearch.keyForHeader(value);
  if (base) return base;
  if (/^(?:website|company website|domain|company domain)$/.test(h)) return 'website';
  if (/^(?:location|city|country|region)$/.test(h)) return 'location';
  if (/^(?:quality|quality score|lead score|relevance|relevance score)$/.test(h)) return 'quality';
  return null;
}

function ensureCoreHeaders(headers, wantsContacts = false) {
  const out = (Array.isArray(headers) ? headers : [])
    .map((value) => String(value ?? '').trim())
    .filter((value, index, arr) => value || index < arr.length)
    .slice(0, 30);
  const keys = new Set(out.map(keyForHeader).filter(Boolean));
  if (!keys.has('name')) out.unshift('Name');
  if (!keys.has('linkedin')) out.push('LinkedIn Profile URL');
  if (wantsContacts && !keys.has('phone')) out.push('Phone No');
  if (wantsContacts && !keys.has('email')) out.push('Email');
  return out.length ? out.slice(0, 30) : DEFAULT_HEADERS.slice();
}

function parseCount(text) {
  const value = String(text || '');
  const direct = value.match(/\b(\d{1,4})\s+(?:new\s+)?(?:leads?|prospects?|people|profiles?|contacts?|founders?|recruiters?|managers?|creators?)\b/i);
  const nearFind = value.match(/\b(?:find|research|discover|source|collect|get|bring|build|generate|scrape|make)\s+(?:me\s+)?(\d{1,4})\b/i);
  const count = Number(direct?.[1] || nearFind?.[1] || 25);
  return Math.max(1, Math.min(MAX_LEADS, Number.isFinite(count) ? count : 25));
}

function wantsContactEnrichment(text) {
  return /\b(?:apollo|phone|mobile|email|contact details?|contact info(?:rmation)?|number)\b/i.test(String(text || ''));
}

function headersFromText(text) {
  const value = String(text || '');
  const match = value.match(/\b(?:headers?|columns?)\s*[:=-]\s*([^\n]+)/i);
  if (!match) return null;
  const parts = match[1]
    .split(/\s*(?:\||,|;|→|>)\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
  return parts.length >= 2 ? parts.slice(0, 30) : null;
}

function cleanCriteria(text) {
  let value = leadResearch.cleanCriteria(text);
  value = String(value || '')
    .replace(/\b(?:and\s+)?(?:create|make|build|open|start)\s+(?:me\s+)?(?:a\s+)?(?:new\s+)?(?:google\s+)?(?:sheet|spreadsheet)\b/gi, ' ')
    .replace(/\b(?:put|save|write|add)\s+(?:them|it|these)?\s*(?:into|in|to)\s+(?:a\s+)?(?:new\s+)?(?:google\s+)?(?:sheet|spreadsheet)\b/gi, ' ')
    .replace(/\b(?:use|using)\s+(?:the\s+)?(?:previous|last|same)\s+(?:format|headings?|headers?|layout)\b/gi, ' ')
    .replace(/\b(?:headers?|columns?)\s*[:=-][^\n]+/gi, ' ')
    .replace(/\b(?:with|including)\s+(?:their\s+)?(?:email|phone|mobile|number|contact details?|contact information)(?:\s*(?:and|&|\+)\s*(?:email|phone|mobile|number))?\b/gi, ' ')
    .replace(/\b(?:using|through|via)\s+apollo\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return value || 'business professionals';
}

function isWorkspaceRequest(text) {
  const value = String(text || '').trim();
  if (!value || sheets.extractSheetUrl(value) || /1drv\.ms|onedrive\.live\.com|sharepoint\.com/i.test(value)) return false;
  const leadNoun = /\b(?:leads?|prospects?|decision makers?|founders?|recruiters?|hiring managers?|hr managers?|people|profiles?|contacts?|creators?)\b/i.test(value);
  const discovery = /\b(?:find|research|discover|source|collect|get|bring|build|generate|look\s*up|scrape|make)\b/i.test(value);
  const destination = /\b(?:sheet|spreadsheet|lead list|lead database|lead sheet)\b/i.test(value);
  const direct = /\b(?:bring|get|find|make)\s+me\b[\s\S]{0,120}\bleads?\b/i.test(value);
  return leadNoun && discovery && (destination || direct || /\bcreate\b[\s\S]{0,80}\bleads?\b/i.test(value));
}

function parseRequest(text) {
  if (!isWorkspaceRequest(text)) return null;
  const value = String(text || '').trim();
  return {
    originalMessage: value,
    count: parseCount(value),
    criteria: cleanCriteria(value),
    wantsContactEnrichment: wantsContactEnrichment(value),
    explicitHeaders: headersFromText(value),
    usePrevious: /\b(?:use|same as|like)\s+(?:the\s+)?(?:previous|last|same)\s+(?:format|headings?|headers?|layout|one)\b|\bsame\s+format\b/i.test(value),
    requestedAt: nowIso(),
  };
}

async function request(url, options = {}) {
  const token = await googleAuth.accessToken();
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch {}
  if (!response.ok) {
    const error = new Error(data?.error?.message || `Google Sheets API failed (${response.status}).`);
    error.status = response.status;
    error.code = response.status === 403 ? 'GOOGLE_SHEETS_FORBIDDEN' : 'GOOGLE_SHEETS_API_ERROR';
    throw error;
  }
  return data;
}

async function writeValues(id, sheetName, range, rows) {
  const full = `${sheets.quoteSheet(sheetName)}!${range}`;
  return request(`${API}/${encodeURIComponent(id)}/values/${encodeURIComponent(full)}?valueInputOption=RAW`, {
    method: 'PUT',
    body: JSON.stringify({ majorDimension: 'ROWS', values: rows }),
  });
}

async function appendValues(id, sheetName, rows) {
  if (!rows.length) return { updatedRows: 0 };
  const full = `${sheets.quoteSheet(sheetName)}!A:ZZ`;
  const result = await request(`${API}/${encodeURIComponent(id)}/values/${encodeURIComponent(full)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    body: JSON.stringify({ majorDimension: 'ROWS', values: rows }),
  });
  return { updatedRows: Number(result?.updates?.updatedRows || rows.length) };
}

function safeTitle(criteria) {
  const clean = String(criteria || 'Leads')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[^a-z0-9 ()&+._-]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 70) || 'Leads';
  const date = new Date().toISOString().slice(0, 10);
  return `ULTRON Leads - ${clean} - ${date}`;
}

function columnWidthForHeader(header) {
  const key = keyForHeader(header);
  if (key === 'details') return 420;
  if (key === 'linkedin' || key === 'source' || key === 'website') return 280;
  if (key === 'email') return 220;
  if (key === 'name' || key === 'company' || key === 'role') return 190;
  if (key === 'phone') return 150;
  if (key === 'quality') return 110;
  return 110;
}

async function formatSpreadsheet(id, sheetId, headers, rowCount) {
  const requests = [
    { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: headers.length },
        cell: { userEnteredFormat: { textFormat: { bold: true }, verticalAlignment: 'MIDDLE', wrapStrategy: 'WRAP' } },
        fields: 'userEnteredFormat(textFormat.bold,verticalAlignment,wrapStrategy)',
      },
    },
    {
      setBasicFilter: {
        filter: { range: { sheetId, startRowIndex: 0, endRowIndex: rowCount, startColumnIndex: 0, endColumnIndex: headers.length } },
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: rowCount, startColumnIndex: 0, endColumnIndex: headers.length },
        cell: { userEnteredFormat: { verticalAlignment: 'TOP', wrapStrategy: 'WRAP' } },
        fields: 'userEnteredFormat(verticalAlignment,wrapStrategy)',
      },
    },
  ];
  headers.forEach((header, index) => {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: index, endIndex: index + 1 },
        properties: { pixelSize: columnWidthForHeader(header) },
        fields: 'pixelSize',
      },
    });
  });
  await request(`${API}/${encodeURIComponent(id)}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests }),
  });
  return true;
}

async function createSpreadsheet(title, headers, rowTarget = 100) {
  const columnCount = Math.max(8, Math.min(30, headers.length));
  const rowCount = Math.max(200, Math.min(2500, Number(rowTarget || 100) + 80));
  const created = await request(API, {
    method: 'POST',
    body: JSON.stringify({
      properties: { title },
      sheets: [{ properties: { title: 'Leads', gridProperties: { rowCount, columnCount } } }],
    }),
  });
  const id = String(created?.spreadsheetId || '').trim();
  const sheetId = Number(created?.sheets?.[0]?.properties?.sheetId);
  if (!id) throw new Error('Google created a spreadsheet but did not return its ID.');
  await writeValues(id, 'Leads', `A1:${sheets.columnName(headers.length - 1)}1`, [headers]);
  let formatted = false;
  if (Number.isInteger(sheetId)) {
    try { formatted = await formatSpreadsheet(id, sheetId, headers, rowCount); } catch {}
  }
  return {
    spreadsheetId: id,
    sheetId: Number.isInteger(sheetId) ? sheetId : null,
    sheetName: 'Leads',
    title: created?.properties?.title || title,
    url: `https://docs.google.com/spreadsheets/d/${id}/edit`,
    formatted,
  };
}

function rememberTemplate(headers, metadata = {}) {
  const cleanHeaders = (headers || []).map((value) => String(value ?? '').trim());
  if (!cleanHeaders.some(Boolean)) return null;
  const state = loadState();
  const fingerprint = cleanHeaders.map(normalizeHeader).join('|');
  const previous = (state.templates || []).find((item) => item.fingerprint === fingerprint);
  state.templates = (state.templates || []).filter((item) => item.fingerprint !== fingerprint);
  const template = {
    id: previous?.id || `template-${Date.now()}`,
    fingerprint,
    headers: cleanHeaders,
    sourceTitle: metadata.sourceTitle || previous?.sourceTitle || null,
    sourceUrl: metadata.sourceUrl || previous?.sourceUrl || null,
    provider: metadata.provider || previous?.provider || null,
    learnedAt: previous?.learnedAt || nowIso(),
    lastUsedAt: nowIso(),
    useCount: Number(previous?.useCount || 0) + 1,
  };
  state.templates.push(template);
  saveState(state);
  return template;
}

function latestTemplate() {
  const state = loadState();
  return [...(state.templates || [])]
    .sort((a, b) => String(b.lastUsedAt || b.learnedAt || '').localeCompare(String(a.lastUsedAt || a.learnedAt || '')))[0] || null;
}

async function learnLatestSpreadsheetTemplate() {
  const enrichmentState = leadEnrichment.loadState();
  const jobs = [...(enrichmentState.jobs || [])].reverse();
  for (const job of jobs) {
    if (!job?.sheetUrl) continue;
    try {
      const adapter = leadEnrichment.adapterFor(job.sheetUrl, job.provider);
      const layout = await adapter.inspect(job.sheetUrl);
      const data = await adapter.readSheet(job.sheetUrl, layout);
      const header = (data.rows?.[layout.headerRowIndex] || []).map((value) => String(value ?? '').trim());
      let last = header.length - 1;
      while (last >= 0 && !header[last]) last--;
      if (last < 0) continue;
      return rememberTemplate(header.slice(0, last + 1), {
        sourceTitle: layout.spreadsheetTitle || job.spreadsheetTitle || null,
        sourceUrl: job.sheetUrl,
        provider: job.provider || adapter.provider || 'google',
      });
    } catch {}
  }
  return latestTemplate();
}

function templatePreview(template) {
  if (!template?.headers?.length) return DEFAULT_HEADERS.join(' | ');
  return template.headers.map((value) => value || '(blank)').join(' | ');
}

function setPendingPlan(plan, template = null) {
  const state = loadState();
  state.pendingPlan = {
    ...plan,
    suggestedTemplateId: template?.id || null,
    suggestedHeaders: template?.headers || DEFAULT_HEADERS,
    suggestedSourceTitle: template?.sourceTitle || null,
    createdAt: nowIso(),
  };
  saveState(state);
  return state.pendingPlan;
}

function clearPendingPlan() {
  const state = loadState();
  state.pendingPlan = null;
  saveState(state);
}

function pendingPlan() {
  const state = loadState();
  const plan = state.pendingPlan;
  if (!plan) return null;
  const age = Date.now() - Date.parse(plan.createdAt || 0);
  if (!Number.isFinite(age) || age > PENDING_TTL_MS) {
    state.pendingPlan = null;
    saveState(state);
    return null;
  }
  return plan;
}

function criteriaTokens(criteria) {
  return [...new Set(
    String(criteria || '')
      .toLowerCase()
      .replace(/[^a-z0-9+#. ]+/g, ' ')
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !GENERIC_CRITERIA_WORDS.has(token))
  )].slice(0, 18);
}

function leadRelevanceScore(lead, criteria) {
  const tokens = criteriaTokens(criteria);
  if (!tokens.length) return 60;
  const titleText = `${lead?.name || ''} ${lead?.role || ''} ${lead?.company || ''}`.toLowerCase();
  const bodyText = String(lead?.snippet || '').toLowerCase();
  let strong = 0;
  let weak = 0;
  for (const token of tokens) {
    if (titleText.includes(token)) strong++;
    else if (bodyText.includes(token)) weak++;
  }
  return Math.round(Math.min(100, 18 + strong * 22 + weak * 9));
}

function qualifiedLead(lead, criteria) {
  if (!lead?.linkedin) return false;
  const tokens = criteriaTokens(criteria);
  if (tokens.length <= 1) return true;
  return leadRelevanceScore(lead, criteria) >= 27;
}

function identityTokens(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !/^(?:the|and|for|pvt|ltd|llp|inc|corp|company|technologies|solutions)$/.test(token));
}

function identityEvidence(text, lead) {
  const haystack = String(text || '').toLowerCase();
  if (!haystack) return false;
  const nameTokens = identityTokens(lead?.name);
  const companyTokens = identityTokens(lead?.company);
  const nameHits = nameTokens.filter((token) => haystack.includes(token)).length;
  const companyHits = companyTokens.filter((token) => haystack.includes(token)).length;
  if (nameTokens.length >= 2 && nameHits >= 2) return true;
  if (nameTokens.length === 1 && nameHits === 1 && companyHits >= 1) return true;
  return nameHits >= 1 && companyHits >= 1;
}

function queryPlan(criteria, count) {
  const c = String(criteria || '').trim();
  const quoted = c.length <= 90 ? `"${c}"` : c;
  const modifiers = ['founder', 'co-founder', 'recruiter', 'talent acquisition', 'hiring manager', 'head', 'director', 'manager', 'consultant', 'creator', 'specialist', 'lead', 'owner', 'vp'];
  const queries = [
    `site:linkedin.com/in ${c}`,
    `site:linkedin.com/in ${quoted}`,
    `${c} LinkedIn profile`,
    `${quoted} LinkedIn`,
    `site:linkedin.com/in ${c} India`,
    `${c} contact LinkedIn`,
  ];
  for (const modifier of modifiers) {
    queries.push(`site:linkedin.com/in ${c} ${modifier}`);
    queries.push(`${c} ${modifier} LinkedIn profile`);
  }
  const maxQueries = Math.min(48, Math.max(6, Math.ceil(Number(count || 25) / 5) + 6));
  return [...new Set(queries.map((q) => q.replace(/\s+/g, ' ').trim()))].slice(0, maxQueries);
}

function publicScrapeCandidate(url) {
  try {
    const parsed = new URL(String(url || ''));
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    if (/linkedin\.com$|facebook\.com$|instagram\.com$|x\.com$|twitter\.com$|tiktok\.com$|apollo\.io$|zoominfo\.com$|rocketreach\.co$/i.test(host)) return false;
    if (/\/(?:login|signin|sign-in|auth|account)(?:\/|$|\?)/i.test(parsed.pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

function retryableWebError(error) {
  const status = Number(error?.status || 0);
  const message = String(error?.message || '');
  return [408, 425, 429, 500, 502, 503, 504].includes(status)
    || /timeout|timed out|temporar|rate limit|too many|ECONNRESET|fetch failed/i.test(message);
}

async function searchWithRetry(query, options = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= SEARCH_RETRY_DELAYS.length; attempt++) {
    try {
      return await web.searchWeb(query, options);
    } catch (error) {
      lastError = error;
      if (!retryableWebError(error) || attempt >= SEARCH_RETRY_DELAYS.length) break;
      await sleep(SEARCH_RETRY_DELAYS[attempt]);
    }
  }
  throw lastError || new Error('Web search failed.');
}

function deepBudgets(totalLeads) {
  const count = Math.max(1, Number(totalLeads || 1));
  return {
    maxLeads: Math.min(count, Math.max(20, Math.min(70, Math.ceil(count * 0.45)))),
    maxSearches: Math.min(70, Math.max(16, Math.ceil(count * 0.45))),
    maxFetches: Math.min(40, Math.max(10, Math.ceil(count * 0.22))),
  };
}

async function deepPublicContactPass(leads, criteria, mission, saveMission) {
  const candidates = leads.filter((lead) => !lead.email || !lead.phone);
  const budgets = deepBudgets(leads.length);
  const limited = candidates.slice(0, budgets.maxLeads);
  let fetches = Number(mission.deepFetches || 0);
  let searches = Number(mission.deepSearches || 0);
  let index = Math.max(0, Number(mission.deepIndex || 0));

  for (; index < limited.length; index++) {
    if (searches >= budgets.maxSearches || fetches >= budgets.maxFetches) break;
    const lead = limited[index];
    if (!lead.name) {
      mission.deepIndex = index + 1;
      saveMission();
      continue;
    }
    const company = lead.company ? `"${lead.company}"` : criteria;
    const queries = [`"${lead.name}" ${company} email phone contact`, `"${lead.name}" ${company} contact`];
    for (const q of queries) {
      if ((lead.email && lead.phone) || searches >= budgets.maxSearches) break;
      try {
        const result = await searchWithRetry(q, { limit: 5 });
        searches++;
        for (const item of result.results || []) {
          const snippet = `${item?.title || ''}\n${item?.snippet || ''}`;
          const snippetMatchesIdentity = identityEvidence(snippet, lead);
          if (snippetMatchesIdentity) {
            if (!lead.email) lead.email = leadEnrichment.extractRowEmail([snippet]) || lead.email;
            if (!lead.phone) lead.phone = leadEnrichment.extractRowPhone([snippet]) || lead.phone;
            if ((lead.email || lead.phone) && !lead.publicContactSource) lead.publicContactSource = String(item?.url || '').trim() || lead.publicContactSource;
          }
          if (lead.email && lead.phone) break;
          if (fetches >= budgets.maxFetches || !publicScrapeCandidate(item?.url)) continue;
          try {
            const page = await web.fetchPage(item.url, { maxTextChars: 18000 });
            fetches++;
            if (!identityEvidence(page.text, lead)) continue;
            if (!lead.email) lead.email = leadEnrichment.extractRowEmail([page.text]) || lead.email;
            if (!lead.phone) lead.phone = leadEnrichment.extractRowPhone([page.text]) || lead.phone;
            if ((lead.email || lead.phone) && !lead.publicContactSource) lead.publicContactSource = page.url;
          } catch {}
          if (lead.email && lead.phone) break;
        }
      } catch {}
    }
    mission.deepIndex = index + 1;
    mission.deepSearches = searches;
    mission.deepFetches = fetches;
    mission.updatedAt = nowIso();
    saveMission();
  }
  mission.deepBudgets = budgets;
  mission.deepSearches = searches;
  mission.deepFetches = fetches;
  mission.deepIndex = index;
  mission.updatedAt = nowIso();
  saveMission();
  return { searches, fetches, budgets, processed: index };
}

function leadRow(lead, headers) {
  const row = Array(headers.length).fill('');
  for (let index = 0; index < headers.length; index++) {
    const key = keyForHeader(headers[index]);
    if (key === 'name') row[index] = lead.name || '';
    else if (key === 'company') row[index] = lead.company || '';
    else if (key === 'role') row[index] = lead.role || '';
    else if (key === 'linkedin') row[index] = lead.linkedin || '';
    else if (key === 'phone') row[index] = lead.phone || '';
    else if (key === 'email') row[index] = lead.email || '';
    else if (key === 'source') row[index] = lead.publicContactSource || lead.source || '';
    else if (key === 'details') row[index] = lead.snippet || '';
    else if (key === 'website') row[index] = lead.publicContactSource || '';
    else if (key === 'quality') row[index] = lead.relevanceScore ?? '';
  }
  return row;
}

function secondaryLeadKey(lead) {
  const name = String(lead?.name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const company = String(lead?.company || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return name && company ? `${name}|${company}` : null;
}

function dedupeLeads(leads) {
  const seenLinkedIn = new Set();
  const seenSecondary = new Set();
  const unique = [];
  let removed = 0;
  for (const lead of leads || []) {
    const linkedin = apollo.normalizeLinkedIn(lead?.linkedin);
    const secondary = secondaryLeadKey(lead);
    if ((linkedin && seenLinkedIn.has(linkedin)) || (secondary && seenSecondary.has(secondary))) {
      removed++;
      continue;
    }
    if (linkedin) seenLinkedIn.add(linkedin);
    if (secondary) seenSecondary.add(secondary);
    unique.push({ ...lead, linkedin: linkedin || lead.linkedin });
  }
  return { leads: unique, removed };
}

async function existingLinkedIns(mission) {
  const rows = await request(`${API}/${encodeURIComponent(mission.spreadsheetId)}/values/${encodeURIComponent(`${sheets.quoteSheet(mission.sheetName)}!A:ZZ`)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`);
  const values = rows.values || [];
  const idx = mission.headers.findIndex((header) => keyForHeader(header) === 'linkedin');
  if (idx < 0) throw new Error('The destination sheet no longer has a LinkedIn column, so ULTRON stopped instead of risking duplicate writes.');
  const set = new Set();
  for (let i = 1; i < values.length; i++) {
    const url = apollo.normalizeLinkedIn(values[i]?.[idx]);
    if (url) set.add(url);
  }
  return set;
}

function missionById(state, id) {
  return (state.missions || []).find((item) => item.id === id) || null;
}

async function continueMission(id) {
  const state = loadState();
  const mission = missionById(state, id);
  if (!mission) throw new Error('Lead mission was not found.');
  const saveMission = () => {
    const fresh = loadState();
    const target = missionById(fresh, mission.id);
    if (target) Object.assign(target, mission);
    else fresh.missions.push(mission);
    saveState(fresh);
  };

  try {
    mission.status = 'researching';
    mission.phase = 'search';
    mission.updatedAt = nowIso();
    saveMission();

    const cleaned = dedupeLeads(mission.leads || []);
    mission.leads = cleaned.leads;
    mission.duplicatesRemoved = Number(mission.duplicatesRemoved || 0) + cleaned.removed;
    const seen = new Set(mission.leads.map((lead) => apollo.normalizeLinkedIn(lead.linkedin)).filter(Boolean));
    const seenSecondary = new Set(mission.leads.map(secondaryLeadKey).filter(Boolean));
    const queries = mission.queries || queryPlan(mission.criteria, mission.requested);
    mission.queries = queries;
    mission.failures = mission.failures || [];
    mission.rejectedLowRelevance = Number(mission.rejectedLowRelevance || 0);
    const failuresAtStart = mission.failures.length;

    for (let i = Number(mission.queryIndex || 0); i < queries.length && mission.leads.length < mission.requested; i++) {
      const query = queries[i];
      try {
        const result = await searchWithRetry(query, { limit: 10 });
        for (const item of result.results || []) {
          const lead = leadResearch.parseLead(item, query);
          if (!lead) continue;
          lead.relevanceScore = leadRelevanceScore(lead, mission.criteria);
          if (!qualifiedLead(lead, mission.criteria)) {
            mission.rejectedLowRelevance++;
            continue;
          }
          const linkedin = apollo.normalizeLinkedIn(lead.linkedin);
          const secondary = secondaryLeadKey(lead);
          if (!linkedin || seen.has(linkedin) || (secondary && seenSecondary.has(secondary))) {
            mission.duplicatesRemoved = Number(mission.duplicatesRemoved || 0) + 1;
            continue;
          }
          seen.add(linkedin);
          if (secondary) seenSecondary.add(secondary);
          mission.leads.push({ ...lead, linkedin });
          if (mission.leads.length >= mission.requested) break;
        }
      } catch (error) {
        mission.failures.push({ query, error: error.message, at: nowIso() });
      }
      mission.queryIndex = i + 1;
      mission.updatedAt = nowIso();
      saveMission();
    }

    const failuresThisPass = mission.failures.length - failuresAtStart;
    if (!mission.leads.length && mission.queryIndex >= queries.length && failuresThisPass >= queries.length) {
      mission.queryIndex = 0;
      const error = new Error('Public web search failed for every lead query. The mission checkpoint and empty destination sheet were preserved; fix web search and resume the lead mission.');
      error.code = 'LEAD_RESEARCH_UNAVAILABLE';
      throw error;
    }

    mission.phase = 'deep-public-contact-research';
    mission.status = 'deep-public-contact-research';
    mission.updatedAt = nowIso();
    saveMission();
    await deepPublicContactPass(mission.leads, mission.criteria, mission, saveMission);

    mission.phase = 'writing-sheet';
    mission.status = 'writing-sheet';
    mission.updatedAt = nowIso();
    saveMission();
    const existing = await existingLinkedIns(mission);
    const freshLeads = mission.leads.filter((lead) => {
      const linkedin = apollo.normalizeLinkedIn(lead.linkedin);
      return linkedin && !existing.has(linkedin);
    });
    const rows = freshLeads.map((lead) => leadRow(lead, mission.headers));
    const appended = await appendValues(mission.spreadsheetId, mission.sheetName, rows);

    mission.added = Number(mission.added || 0) + appended.updatedRows;
    mission.publicEmails = mission.leads.filter((lead) => lead.email).length;
    mission.publicPhones = mission.leads.filter((lead) => lead.phone).length;
    mission.missingContacts = mission.leads.filter((lead) => !lead.email || !lead.phone).length;
    mission.averageRelevance = mission.leads.length
      ? Math.round(mission.leads.reduce((sum, lead) => sum + Number(lead.relevanceScore || 0), 0) / mission.leads.length)
      : 0;
    mission.status = mission.wantsContactEnrichment && mission.missingContacts > 0 ? 'awaiting-apollo-approval' : 'completed';
    mission.phase = mission.status;
    mission.completedAt = nowIso();
    mission.updatedAt = nowIso();
    saveMission();
    rememberTemplate(mission.headers, { sourceTitle: mission.spreadsheetTitle, sourceUrl: mission.sheetUrl, provider: 'google' });
    return mission;
  } catch (error) {
    mission.status = error.code === 'LEAD_RESEARCH_UNAVAILABLE' ? 'research-blocked' : 'failed';
    mission.lastError = error.message;
    mission.updatedAt = nowIso();
    saveMission();
    throw error;
  }
}

async function startMission(plan, headers) {
  const webStatus = typeof web.status === 'function' ? web.status() : {};
  if (!webStatus.configured) {
    const error = new Error('Public web lead search is not configured. Configure the existing TinyFish search connection before starting a lead mission; no spreadsheet was created.');
    error.code = 'LEAD_WEB_SEARCH_NOT_CONFIGURED';
    throw error;
  }
  const finalHeaders = ensureCoreHeaders(headers, plan.wantsContactEnrichment);
  const created = await createSpreadsheet(safeTitle(plan.criteria), finalHeaders, plan.count);
  const state = loadState();
  const mission = {
    id: `lead-mission-${Date.now()}`,
    status: 'created',
    phase: 'created',
    requested: plan.count,
    criteria: plan.criteria,
    wantsContactEnrichment: Boolean(plan.wantsContactEnrichment),
    headers: finalHeaders,
    spreadsheetId: created.spreadsheetId,
    spreadsheetTitle: created.title,
    sheetName: created.sheetName,
    sheetUrl: created.url,
    sheetFormatted: Boolean(created.formatted),
    queryIndex: 0,
    deepIndex: 0,
    queries: queryPlan(plan.criteria, plan.count),
    leads: [],
    failures: [],
    duplicatesRemoved: 0,
    rejectedLowRelevance: 0,
    added: 0,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  state.missions.push(mission);
  state.pendingPlan = null;
  saveState(state);
  return continueMission(mission.id);
}

async function prepareRequest(plan) {
  if (plan.explicitHeaders?.length) return { type: 'run', mission: await startMission(plan, plan.explicitHeaders) };
  let template = latestTemplate();
  if (!template || plan.usePrevious) template = await learnLatestSpreadsheetTemplate();
  if (plan.usePrevious) return { type: 'run', mission: await startMission(plan, template?.headers || DEFAULT_HEADERS) };
  const pending = setPendingPlan(plan, template);
  const source = template?.sourceTitle ? ` from ${template.sourceTitle}` : '';
  return {
    type: 'clarification',
    text: `I can create the Google Sheet and run this as a lead mission. Your latest reusable layout${source} is: ${templatePreview(template)}. Do you want the sheet headings like that previous format, the default lead format, or a different layout? You can also reply with “headers: Name, Company, LinkedIn, Post Details, Phone, Email”.`,
    pending,
  };
}

async function resolvePending(text) {
  const pending = pendingPlan();
  if (!pending) return null;
  const value = String(text || '').trim();
  if (/\b(?:cancel|stop|never mind|nevermind)\b/i.test(value)) {
    clearPendingPlan();
    return { type: 'cancelled', text: 'Lead mission cancelled before creating or scraping anything.' };
  }
  const explicitHeaders = headersFromText(value);
  if (explicitHeaders) return { type: 'run', mission: await startMission(pending, explicitHeaders) };
  if (/\b(?:use|same as|keep|go with|like)\b[\s\S]{0,35}\b(?:previous|last|same|that)\b|\bprevious format\b|\bsame format\b|\buse it\b|\blike before\b/i.test(value)) {
    return { type: 'run', mission: await startMission(pending, pending.suggestedHeaders || DEFAULT_HEADERS) };
  }
  if (/\b(?:default|standard|canonical)\b[\s\S]{0,20}\b(?:format|layout|headers?|columns?)?\b/i.test(value)) {
    return { type: 'run', mission: await startMission(pending, DEFAULT_HEADERS) };
  }
  if (/\b(?:different|new|custom)\b[\s\S]{0,30}\b(?:format|layout|headers?|columns?|plan)\b/i.test(value)) {
    return { type: 'clarification', text: 'Send the headings once in this form: headers: Name, Company, Role, LinkedIn, Post Details, Phone, Email. ULTRON will remember that layout for future lead missions.' };
  }
  return null;
}

function latestMission() {
  const state = loadState();
  return [...(state.missions || [])].reverse()[0] || null;
}

async function resumeLatestMission() {
  const mission = latestMission();
  if (!mission) return { ok: false, text: 'There is no saved lead mission to resume.' };
  if (mission.status === 'completed') return { ok: true, mission, alreadyComplete: true };
  if (mission.status === 'awaiting-apollo-approval') return { ok: true, mission, awaitingApollo: true };
  return { ok: true, mission: await continueMission(mission.id) };
}

function isStatusRequest(text) {
  return /\b(?:lead|leads)\s+(?:mission|workspace)\s+status\b|\blead\s+generation\s+status\b/i.test(String(text || ''));
}

function isResumeRequest(text) {
  return /\b(?:resume|continue)\s+(?:the\s+)?(?:latest\s+)?(?:lead|leads)\s+(?:mission|workspace|research)\b/i.test(String(text || ''));
}

function statusText() {
  const mission = latestMission();
  const template = latestTemplate();
  if (!mission) {
    return `Lead Workspace v2 is ready. Google Sheet creation, formatted lead sheets, public-web sourcing, bounded public-page scraping, identity-checked contact recovery, relevance filtering, resumable checkpoints and format memory are available. Latest remembered layout: ${templatePreview(template)}.`;
  }
  const discovered = Number(mission.leads?.length || 0);
  const shortfall = discovered < Number(mission.requested || 0)
    ? ` ${discovered}/${mission.requested} unique qualifying public LinkedIn leads discovered so far.`
    : ` ${mission.requested} requested leads reached.`;
  const quality = mission.averageRelevance ? ` Average relevance ${mission.averageRelevance}/100.` : '';
  const hygiene = ` Duplicates skipped: ${mission.duplicatesRemoved || 0}; low-relevance results rejected: ${mission.rejectedLowRelevance || 0}.`;
  return `Lead mission ${mission.status}: ${mission.criteria}.${shortfall}${quality}${hygiene} ${mission.added || 0} rows written to ${mission.spreadsheetTitle || 'Google Sheet'}. Public contacts found: ${mission.publicEmails || 0} emails, ${mission.publicPhones || 0} phones. Search progress ${mission.queryIndex || 0}/${mission.queries?.length || 0}; deep public searches ${mission.deepSearches || 0}, page fetches ${mission.deepFetches || 0}. Sheet: ${mission.sheetUrl || 'not created yet'}`;
}

function formatMission(mission) {
  const discovered = Number(mission.leads?.length || 0);
  const shortfall = discovered < Number(mission.requested || 0)
    ? ` I found ${discovered} unique qualifying public LinkedIn profiles in this pass, below the requested ${mission.requested}.`
    : '';
  const contacts = ` Public web research found ${mission.publicEmails || 0} email${mission.publicEmails === 1 ? '' : 's'} and ${mission.publicPhones || 0} phone${mission.publicPhones === 1 ? '' : 's'} before Apollo.`;
  const deep = ` Selective public-page research used ${mission.deepSearches || 0} targeted search${mission.deepSearches === 1 ? '' : 'es'} and ${mission.deepFetches || 0} page fetch${mission.deepFetches === 1 ? '' : 'es'}; scraped contact evidence had to match the lead identity before being accepted.`;
  const quality = ` Quality controls skipped ${mission.duplicatesRemoved || 0} duplicate result${mission.duplicatesRemoved === 1 ? '' : 's'} and rejected ${mission.rejectedLowRelevance || 0} low-relevance result${mission.rejectedLowRelevance === 1 ? '' : 's'}${mission.averageRelevance ? `; average accepted relevance ${mission.averageRelevance}/100` : ''}.`;
  return `Lead mission complete, Sir. Created “${mission.spreadsheetTitle}” and added ${mission.added || 0} lead${mission.added === 1 ? '' : 's'} for “${mission.criteria}”.${contacts}${deep}${quality}${shortfall} ${mission.sheetUrl}`;
}

function status() {
  const state = loadState();
  const webStatus = typeof web.status === 'function' ? web.status() : {};
  return {
    ready: Boolean(googleAuth.status().credentialsReady && googleAuth.status().authorized && webStatus.configured),
    stateVersion: 2,
    stateFile: STATE_FILE,
    maxLeadsPerMission: MAX_LEADS,
    templatesRemembered: state.templates.length,
    pendingPlan: Boolean(pendingPlan()),
    latestMission: latestMission(),
    publicWebSearchReady: Boolean(webStatus.configured),
    publicWebOnly: true,
    privateLoginScraping: false,
    formattedSheets: true,
    relevanceFiltering: true,
    identityCheckedContactRecovery: true,
    secondaryDedupe: true,
    resumableDeepResearch: true,
  };
}

module.exports = {
  DEFAULT_HEADERS,
  MAX_LEADS,
  loadState,
  saveState,
  normalizeHeader,
  keyForHeader,
  ensureCoreHeaders,
  parseCount,
  headersFromText,
  cleanCriteria,
  isWorkspaceRequest,
  parseRequest,
  rememberTemplate,
  latestTemplate,
  learnLatestSpreadsheetTemplate,
  templatePreview,
  pendingPlan,
  clearPendingPlan,
  criteriaTokens,
  leadRelevanceScore,
  qualifiedLead,
  identityTokens,
  identityEvidence,
  queryPlan,
  publicScrapeCandidate,
  retryableWebError,
  deepBudgets,
  leadRow,
  secondaryLeadKey,
  dedupeLeads,
  createSpreadsheet,
  startMission,
  continueMission,
  prepareRequest,
  resolvePending,
  latestMission,
  resumeLatestMission,
  isStatusRequest,
  isResumeRequest,
  statusText,
  formatMission,
  status,
};
