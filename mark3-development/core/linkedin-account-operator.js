const fs = require('fs');
const path = require('path');
const googleAuth = require('./google-sheets-auth');
const sheets = require('./google-sheets-operator');
const v2 = require('./lead-workspace-operator-v2');
const linkedinPublic = require('./linkedin-public-research');
const mcp = require('./linkedin-mcp-client');
const joeyism = require('./linkedin-joeyism-bridge');
const policy = require('./linkedin-account-policy');
const apollo = require('./apollo-enrichment');
const config = require('./config');

const API = 'https://sheets.googleapis.com/v4/spreadsheets';
const STATE_FILE = path.join(config.projectRoot, '.ultron', 'linkedin-account', 'operator-state.json');
const PENDING_TTL_MS = 45 * 60 * 1000;

const COMPANY_HEADERS = ['NAME', 'COMPANY NAME', 'COMPANY LINK', 'NO. OF APPLICANTS', 'PHONE NUMBER', 'EMAIL', 'REMARKS'];
const PERSON_HEADERS = ['Name', 'Company', 'Role', 'LinkedIn', 'Location', 'Post Details', 'Email', 'Phone No', 'Source', 'Lead Score'];
const INTERNAL_CONTACT_HEADER = '__ULTRON CONTACT LINKEDIN';

function nowIso() {
  return new Date().toISOString();
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return { version: 1, pending: null, missions: [] };
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { version: 1, pending: null, missions: [], ...parsed, missions: Array.isArray(parsed.missions) ? parsed.missions : [] };
  } catch {
    return { version: 1, pending: null, missions: [] };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  try { fs.chmodSync(STATE_FILE, 0o600); } catch {}
}

function isRequest(text) {
  const value = String(text || '').trim();
  if (!/linkedin\.com\/(?:in|company)\//i.test(value) && !/\blinkedin\b/i.test(value)) return false;
  if (/\b(?:status|health|doctor|setup|login|unlock)\b/i.test(value) && !/\b(?:find|get|scrape|research|source|bring|collect|search|list)\b/i.test(value)) return false;
  return /\b(?:find|get|scrape|research|source|bring|collect|search|list|show|extract|companies|company|people|profiles?|recruiters?|founders?|hiring)\b/i.test(value)
    || /linkedin\.com\/(?:in|company)\//i.test(value);
}

function parseCount(text) {
  const value = String(text || '');
  const match = value.match(/\b(?:find|get|bring|research|source|collect|search|list|show|extract)\s+(?:me\s+)?(\d{1,3})\b/i)
    || value.match(/\b(\d{1,3})\s+(?:companies|company|people|profiles?|professionals?|recruiters?|founders?|leads?)\b/i);
  return Math.max(1, Math.min(100, match ? Number(match[1]) : 25));
}

function wantsContacts(text) {
  return /\b(?:email|e-mail|phone|mobile|number|contact info|contact details?)\b/i.test(String(text || ''));
}

function parseEmployeeRange(text) {
  const value = String(text || '');
  const range = value.match(/\b(\d[\d,]*)\s*(?:-|to)\s*(\d[\d,]*)\s+employees?\b/i);
  if (range) return { min: Number(range[1].replace(/,/g, '')), max: Number(range[2].replace(/,/g, '')) };
  const max = value.match(/\b(?:under|below|fewer than|less than|up to|maximum|max)\s*(\d[\d,]*)\s+employees?\b/i);
  const min = value.match(/\b(?:over|above|more than|at least|minimum|min)\s*(\d[\d,]*)\s+employees?\b/i);
  return {
    min: min ? Number(min[1].replace(/,/g, '')) : null,
    max: max ? Number(max[1].replace(/,/g, '')) : null,
  };
}

function parseFilters(text) {
  const value = String(text || '');
  const employeeRange = parseEmployeeRange(value);
  const workType = /\bremote\b/i.test(value) ? 'remote'
    : /\bhybrid\b/i.test(value) ? 'hybrid'
      : /\b(?:on[- ]?site|in[- ]?office)\b/i.test(value) ? 'on_site' : null;
  const jobType = /\bpart[- ]?time\b/i.test(value) ? 'part_time'
    : /\bcontract\b/i.test(value) ? 'contract'
      : /\bintern(?:ship)?\b/i.test(value) ? 'internship'
        : /\bfull[- ]?time\b/i.test(value) ? 'full_time' : null;
  const experienceLevel = /\bentry[- ]?level\b/i.test(value) ? 'entry'
    : /\bassociate\b/i.test(value) ? 'associate'
      : /\bmid[- ]?senior\b/i.test(value) ? 'mid_senior'
        : /\bexecutive\b/i.test(value) ? 'executive' : null;
  const datePosted = /\bpast\s+24\s+hours?\b|\blast\s+24\s+hours?\b/i.test(value) ? 'past_24_hours'
    : /\bpast\s+week\b|\blast\s+week\b/i.test(value) ? 'past_week'
      : /\bpast\s+month\b|\blast\s+month\b/i.test(value) ? 'past_month' : null;
  return {
    employeeMin: Number.isFinite(employeeRange.min) ? employeeRange.min : null,
    employeeMax: Number.isFinite(employeeRange.max) ? employeeRange.max : null,
    workType,
    jobType,
    experienceLevel,
    datePosted,
    easyApply: /\beasy apply\b/i.test(value),
  };
}

function requestTopic(text, entityMode, location) {
  let value = linkedinPublic.coreTopic(text, entityMode);
  value = value
    .replace(/\b(?:under|below|fewer than|less than|up to|maximum|max|over|above|more than|at least|minimum|min)\s*\d[\d,]*\s+employees?\b/gi, ' ')
    .replace(/\b(?:under|below|fewer than|less than|up to|maximum|max|over|above|more than|at least|minimum|min)\s*\d[\d,]*\b/gi, ' ')
    .replace(/\b\d[\d,]*\s*(?:-|to)\s*\d[\d,]*\s+employees?\b/gi, ' ')
    .replace(/\b(?:remote|hybrid|on[- ]?site|in[- ]?office|easy apply|full[- ]?time|part[- ]?time|contract|internship)\b/gi, ' ')
    .replace(/\b(?:roles?|positions?|should be|must be|located|location|with|employees?|and|from|in|at|near|around)\b/gi, ' ')
    .replace(/[.,;:!?()[\]{}]+/g, ' ');
  if (location) {
    value = value.replace(
      new RegExp(`\\b${String(location).replace(/[.*+?^$(){}|[\]\\]/g, '\\$&')}\\b`, 'gi'),
      ' ',
    );
  }
  value = value.replace(/\s+/g, ' ').trim();

  // Generic SAP requests must canonicalize to "SAP". Preserve a module only
  // when the user explicitly named one, e.g. SAP FICO or SAP ABAP.
  if (/\bsap\b/i.test(value)) {
    const module = value.match(/\bsap\s+(fico|mm|sd|abap|basis|s\/?4hana|successfactors|hana|bw|bpc|ariba|ewm|tm)\b/i);
    if (!module) return 'SAP';
    const raw = module[1];
    return /^s\/?4hana$/i.test(raw) ? 'SAP S/4HANA' : `SAP ${raw.toUpperCase()}`;
  }

  return value || (entityMode === 'company' ? 'companies' : 'professionals');
}

function locationScopeFromText(text, hiring = false) {
  const value = String(text || '');
  if (/\bcompanies?\s+(?:that\s+are\s+)?(?:based|headquartered|located)\b/i.test(value)
      || /\b(?:company|employer)\s+(?:headquarters?|hq)\b/i.test(value)) {
    return 'company';
  }
  return hiring ? 'job' : 'company';
}

function parseRequest(text) {
  const value = String(text || '').trim();
  if (!isRequest(value)) return null;
  const destinationSheetUrl = sheets.extractSheetUrl(value);
  const criteriaText = String(destinationSheetUrl ? value.replace(destinationSheetUrl, ' ') : value)
    .replace(/\b(?:and\s+)?(?:put|write|add|fill|save|append)\s+(?:the\s+)?(?:results?|companies|leads?|rows?)?\s*(?:into|in|to)?\s*(?:my|this|the)?\s*(?:google\s+)?(?:sheet|spreadsheet)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const entity = linkedinPublic.normalizeLinkedInEntityUrl(criteriaText);
  const entityMode = entity?.type || linkedinPublic.entityModeFromText(criteriaText);
  const location = linkedinPublic.locationFromText(criteriaText);
  const hiring = /\b(?:hiring|recruiting|jobs?|vacanc(?:y|ies)|openings?|roles?)\b/i.test(criteriaText);
  return {
    originalMessage: value,
    criteriaText,
    count: entity ? 1 : parseCount(criteriaText),
    entityMode,
    exactUrl: entity?.url || null,
    exactSlug: entity?.slug || null,
    location,
    locationScope: locationScopeFromText(criteriaText, hiring),
    hiring,
    topic: requestTopic(criteriaText, entityMode, location),
    wantsContacts: true,
    filters: parseFilters(criteriaText),
    destinationSheetUrl,
    explicitHeaders: v2.headersFromText(value),
    usePrevious: /\b(?:use|same as|like)\b[\s\S]{0,30}\b(?:previous|last)\b|\bprevious format\b|\bsame format\b/i.test(value),
    useDefault: /\b(?:default|standard)\s+(?:format|layout|headers?|columns?)\b/i.test(value),
  };
}

function normalizeHeader(value) {
  return String(value || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function headerKey(value) {
  const h = normalizeHeader(value);
  if (/ultron contact linkedin/.test(h)) return 'contactLinkedin';
  if (/^(?:person or company name|name|person|full name|contact name)$/.test(h)) return 'name';
  if (/^(?:company|company name|organization|organisation|organization name|organisation name|employer|business|business name)$/.test(h)) return 'company';
  if (/^(?:role|title|job title|job role|sap role|opening|job opening|position)$/.test(h)) return 'role';
  if (/^(?:job link|job url|linkedin job|linkedin job link|job posting link|job opening link|opening url|posting url)$/.test(h)) return 'jobLink';
  if (/linkedin|company link|company url|company profile/.test(h)) return 'linkedin';
  if (/^(?:location|job location|city|region|state)$/.test(h)) return 'location';
  if (/^(?:hiring signal|job signal|hiring activity|hiring evidence|job evidence)$/.test(h)) return 'hiring';
  if (/^(?:work type|workplace type|workplace|remote status|work mode|working mode)$/.test(h)) return 'workType';
  if (/^(?:employees?|employee count|company size|headcount|team size)$/.test(h)) return 'employees';
  if (/^(?:post details|details|description|profile details|linkedin details|notes)$/.test(h)) return 'details';
  if (/^(?:website|company website|site)$/.test(h)) return 'website';
  if (/phone|mobile|contact number|telephone/.test(h)) return 'phone';
  if (/email|e mail/.test(h)) return 'email';
  if (/^(?:remarks?|contact remarks?|contact person|contact identity)$/.test(h)) return 'remarks';
  if (/applicants?/.test(h)) return 'applicants';
  if (/^(?:source|source url|linkedin source)$/.test(h)) return 'source';
  if (/^(?:lead score|score|quality|relevance)$/.test(h)) return 'score';
  return null;
}

function ensureHeaders(headers, request) {
  const defaults = request.entityMode === 'company' ? COMPANY_HEADERS : PERSON_HEADERS;
  const source = Array.isArray(headers) && headers.length ? headers : defaults;
  const out = source.map((value) => String(value ?? '').trim()).slice(0, 30);
  const keys = new Set(out.map(headerKey).filter(Boolean));
  const needed = request.entityMode === 'company'
    ? [['name', 'NAME'], ['company', 'COMPANY NAME'], ['linkedin', 'COMPANY LINK'], ['applicants', 'NO. OF APPLICANTS'], ['phone', 'PHONE NUMBER'], ['email', 'EMAIL']]
    : [['name', 'Name'], ['company', 'Company'], ['role', 'Role'], ['linkedin', 'LinkedIn'], ['location', 'Location'], ['details', 'Post Details'], ['source', 'Source'], ['score', 'Lead Score']];
  if (request.entityMode === 'company') {
    if (request.hiring) needed.push(['role', 'SAP ROLE'], ['jobLink', 'JOB LINK']);
    if (request.location) needed.push(['location', 'LOCATION']);
    if (request.filters?.workType) needed.push(['workType', 'WORK TYPE']);
    if (request.filters?.employeeMin != null || request.filters?.employeeMax != null) needed.push(['employees', 'EMPLOYEES']);
    if (request.hiring) needed.push(['hiring', 'HIRING SIGNAL']);
  }
  if (request.wantsContacts) {
    needed.push(['email', 'Email'], ['phone', 'Phone No']);
  }
  for (const [key, label] of needed) if (!keys.has(key)) { out.push(label); keys.add(key); }
  if (request.entityMode === 'company' && !keys.has('remarks')) {
    const emailIndex = out.findIndex((header) => headerKey(header) === 'email');
    out.splice(emailIndex >= 0 ? emailIndex + 1 : out.length, 0, 'REMARKS');
  }
  return out.slice(0, 30);
}

function pendingRequest() {
  const state = loadState();
  if (!state.pending) return null;
  const age = Date.now() - Date.parse(state.pending.createdAt || 0);
  if (!Number.isFinite(age) || age > PENDING_TTL_MS) {
    state.pending = null;
    saveState(state);
    return null;
  }
  return state.pending;
}

function setPending(request, template) {
  const state = loadState();
  state.pending = {
    ...request,
    suggestedHeaders: template?.headers || (request.entityMode === 'company' ? COMPANY_HEADERS : PERSON_HEADERS),
    suggestedSourceTitle: template?.sourceTitle || null,
    createdAt: nowIso(),
  };
  saveState(state);
  return state.pending;
}

function clearPending() {
  const state = loadState();
  state.pending = null;
  saveState(state);
}

function destinationHeaderCandidate(rows) {
  let best = null;
  for (let r = 0; r < Math.min(rows.length, 30); r++) {
    const row = Array.isArray(rows[r]) ? rows[r] : [];
    const nonEmpty = row.filter((value) => String(value ?? '').trim()).length;
    if (!nonEmpty) continue;
    const recognized = row.map(headerKey).filter(Boolean).length;
    const score = recognized * 20 + Math.min(nonEmpty, 12) - r * 0.1;
    if (!best || score > best.score) {
      best = { rowIndex: r, rowNumber: r + 1, headers: row.map((value) => String(value ?? '').trim()), recognized, score };
    }
  }
  return best;
}

async function inspectDestinationSheet(url, request) {
  const spreadsheetId = sheets.spreadsheetId(url);
  const meta = await sheets.metadata(spreadsheetId);
  const requestedGid = sheets.sheetGid(url);
  const tabs = [...(meta.sheets || [])].sort((a, b) => {
    if (requestedGid != null) {
      if (a?.properties?.sheetId === requestedGid) return -1;
      if (b?.properties?.sheetId === requestedGid) return 1;
    }
    return Number(a?.properties?.index || 0) - Number(b?.properties?.index || 0);
  });

  let chosen = null;
  for (const tab of tabs) {
    const title = tab?.properties?.title;
    if (!title) continue;
    const preview = await sheets.values(spreadsheetId, `${sheets.quoteSheet(title)}!A1:ZZ80`);
    const candidate = destinationHeaderCandidate(preview);
    if (candidate && (candidate.recognized > 0 || candidate.headers.filter(Boolean).length >= 2)) {
      chosen = { ...candidate, sheetName: title, sheetId: tab.properties.sheetId, preview };
      break;
    }
    if (!chosen && preview.length === 0) {
      chosen = { rowIndex: 0, rowNumber: 1, headers: [], recognized: 0, score: 0, sheetName: title, sheetId: tab.properties.sheetId, preview: [] };
      if (requestedGid != null && tab.properties.sheetId === requestedGid) break;
    }
  }

  if (!chosen) {
    const error = new Error('The provided Google Sheet does not contain a usable header row, and ULTRON stopped rather than guessing where to write.');
    error.code = 'LINKEDIN_DESTINATION_HEADERS_NOT_FOUND';
    throw error;
  }

  const baseHeaders = chosen.headers.some(Boolean)
    ? chosen.headers
    : (request.entityMode === 'company' ? COMPANY_HEADERS : PERSON_HEADERS);
  const headers = ensureHeaders(baseHeaders, request);
  const fullRows = await sheets.values(spreadsheetId, `${sheets.quoteSheet(chosen.sheetName)}!A:ZZ`);
  let lastNonEmptyRow = 0;
  for (let i = 0; i < fullRows.length; i++) {
    if ((fullRows[i] || []).some((value) => String(value ?? '').trim())) lastNonEmptyRow = i + 1;
  }

  return {
    spreadsheetId,
    spreadsheetTitle: meta?.properties?.title || 'Google Sheet',
    sheetName: chosen.sheetName,
    sheetId: chosen.sheetId,
    headerRowNumber: chosen.rowNumber,
    originalHeaders: chosen.headers,
    headers,
    rows: fullRows,
    lastNonEmptyRow,
    url,
  };
}

async function syncDestinationHeaders(destination, headers) {
  const changes = [];
  for (let index = 0; index < headers.length; index++) {
    const current = String(destination.rows?.[destination.headerRowNumber - 1]?.[index] ?? '').trim();
    const next = String(headers[index] ?? '').trim();
    if (current !== next) {
      changes.push({
        range: sheets.cellRange(destination.sheetName, destination.headerRowNumber, index),
        value: next,
      });
    }
  }
  if (changes.length) await sheets.writeCells(destination.spreadsheetId, changes);
  destination.headers = headers;
  destination.rows[destination.headerRowNumber - 1] = headers.slice();
  return changes.length;
}

function destinationExistingKeys(destination, headers) {
  const linkedinIndex = headers.findIndex((header) => headerKey(header) === 'linkedin');
  const jobIndex = headers.findIndex((header) => headerKey(header) === 'jobLink');
  const companyIndex = headers.findIndex((header) => headerKey(header) === 'company');
  const keys = new Set();
  for (let r = destination.headerRowNumber; r < (destination.rows || []).length; r++) {
    const row = destination.rows[r] || [];
    const linkedin = linkedinIndex >= 0 ? String(row[linkedinIndex] || '').trim().toLowerCase() : '';
    const job = jobIndex >= 0 ? String(row[jobIndex] || '').trim().toLowerCase() : '';
    const company = companyIndex >= 0 ? normalizeHeader(row[companyIndex]) : '';
    if (linkedin) keys.add(`linkedin:${linkedin}`);
    if (job) keys.add(`job:${job}`);
    if (company) keys.add(`company:${company}`);
  }
  return keys;
}

function recordDestinationKeys(record) {
  const keys = [];
  if (record?.linkedin) keys.push(`linkedin:${String(record.linkedin).trim().toLowerCase()}`);
  if (record?.jobUrl) keys.push(`job:${String(record.jobUrl).trim().toLowerCase()}`);
  if (record?.company) keys.push(`company:${normalizeHeader(record.company)}`);
  return keys.filter((key) => !/:$/.test(key));
}

async function prepare(request) {
  if (request.destinationSheetUrl) {
    const destination = await inspectDestinationSheet(request.destinationSheetUrl, request);
    const nextRequest = {
      ...request,
      destinationSheet: {
        spreadsheetId: destination.spreadsheetId,
        spreadsheetTitle: destination.spreadsheetTitle,
        sheetName: destination.sheetName,
        sheetId: destination.sheetId,
        headerRowNumber: destination.headerRowNumber,
      },
    };
    return { type: 'run', request: nextRequest, headers: destination.headers };
  }
  if (request.entityMode === 'company' && !request.explicitHeaders?.length && !request.usePrevious) {
    return { type: 'run', request, headers: ensureHeaders([...COMPANY_HEADERS], request) };
  }
  if (request.exactUrl || request.explicitHeaders?.length || request.useDefault || request.usePrevious) {
    let headers = request.explicitHeaders;
    if (!headers && request.usePrevious) {
      const template = v2.latestTemplate();
      headers = template?.headers;
    }
    if (!headers) headers = request.entityMode === 'company' ? COMPANY_HEADERS : PERSON_HEADERS;
    return { type: 'run', request, headers: ensureHeaders(headers, request) };
  }
  const template = v2.latestTemplate();
  const pending = setPending(request, template);
  const previous = template?.headers?.length ? v2.templatePreview(template) : 'none remembered yet';
  const defaults = (request.entityMode === 'company' ? COMPANY_HEADERS : PERSON_HEADERS).join(' | ');
  return {
    type: 'clarification',
    pending,
    text: `This is a dedicated LinkedIn-only mission. I will not use Google Jobs, Maps, TinyFish or SerpApi for discovery. Apollo may enrich only a LinkedIn-verified decision-maker after one-run approval. Previous sheet headings: ${previous}. LinkedIn default: ${defaults}. Use previous format, default format, send headers: ..., or send a Google Sheets URL and I will fill that sheet directly.`,
  };
}

async function resolvePending(text) {
  const pending = pendingRequest();
  if (!pending) return null;
  const value = String(text || '').trim();
  if (/\b(?:cancel|stop|never mind|nevermind)\b/i.test(value)) {
    clearPending();
    return { type: 'cancelled', text: 'LinkedIn-only mission cancelled before account scraping started.' };
  }
  const destinationSheetUrl = sheets.extractSheetUrl(value);
  if (destinationSheetUrl) {
    const request = { ...pending, destinationSheetUrl };
    clearPending();
    const destination = await inspectDestinationSheet(destinationSheetUrl, request);
    request.destinationSheet = {
      spreadsheetId: destination.spreadsheetId,
      spreadsheetTitle: destination.spreadsheetTitle,
      sheetName: destination.sheetName,
      sheetId: destination.sheetId,
      headerRowNumber: destination.headerRowNumber,
    };
    return { type: 'run', request, headers: destination.headers };
  }
  const custom = v2.headersFromText(value);
  if (custom) {
    clearPending();
    return { type: 'run', request: pending, headers: ensureHeaders(custom, pending) };
  }
  if (/\b(?:previous|last|same|use it|like before)\b/i.test(value)) {
    clearPending();
    return { type: 'run', request: pending, headers: ensureHeaders(pending.suggestedHeaders, pending) };
  }
  if (/\b(?:default|standard|linkedin default)\b/i.test(value)) {
    clearPending();
    const defaults = pending.entityMode === 'company' ? COMPANY_HEADERS : PERSON_HEADERS;
    return { type: 'run', request: pending, headers: ensureHeaders(defaults, pending) };
  }
  if (/\b(?:different|custom|new)\b[\s\S]{0,30}\b(?:format|headers?|columns?|layout)\b/i.test(value)) {
    return { type: 'clarification', pending, text: 'Send the layout as: headers: NAME, COMPANY NAME, COMPANY LINK, NO. OF APPLICANTS, PHONE NUMBER, EMAIL, REMARKS.' };
  }
  return null;
}

function flattenText(value, depth = 0) {
  if (depth > 5 || value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => flattenText(item, depth + 1)).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    return Object.entries(value)
      .filter(([key]) => !/cookie|token|password|session/i.test(key))
      .map(([, item]) => flattenText(item, depth + 1))
      .filter(Boolean)
      .join('\n');
  }
  return String(value);
}

function collectReferences(value, out = [], depth = 0) {
  if (depth > 7 || value == null) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, out, depth + 1);
    return out;
  }
  if (typeof value !== 'object') return out;
  const url = String(value.url || value.href || '').trim();
  if (url) out.push({
    url,
    kind: String(value.kind || '').trim(),
    text: String(value.text || value.label || value.title || value.aria_label || '').trim(),
    context: String(value.context || value.heading || value.aria_label || '').trim(),
  });
  for (const [key, item] of Object.entries(value)) {
    if (['url', 'href', 'text', 'label', 'title', 'context'].includes(key)) continue;
    collectReferences(item, out, depth + 1);
  }
  return out;
}

function absoluteLinkedInUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('/')) return 'https://www.linkedin.com' + raw;
  return raw;
}

function linkedInReferences(result, entityMode = null) {
  const refs = collectReferences(result);
  const out = [];
  const seen = new Set();
  for (const ref of refs) {
    const normalized = linkedinPublic.normalizeLinkedInEntityUrl(absoluteLinkedInUrl(ref.url), entityMode);
    if (!normalized || seen.has(normalized.url)) continue;
    seen.add(normalized.url);
    out.push({ ...ref, ...normalized });
  }
  const raw = flattenText(result);
  const regex = /https?:\/\/(?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com\/(?:in|company)\/[a-z0-9%._~-]+\/?/gi;
  for (const match of raw.match(regex) || []) {
    const normalized = linkedinPublic.normalizeLinkedInEntityUrl(match, entityMode);
    if (!normalized || seen.has(normalized.url)) continue;
    seen.add(normalized.url);
    out.push({ url: normalized.url, kind: '', text: '', context: '', ...normalized });
  }
  return out;
}

function jobIdsFromResult(result) {
  const direct = Array.isArray(result?.job_ids) ? result.job_ids : [];
  const text = flattenText(result);
  const fromUrls = [...text.matchAll(/linkedin\.com\/jobs\/view\/(?:[^\d\s/]*-)?(\d{6,})/gi)].map((match) => match[1]);
  return [...new Set([...direct, ...fromUrls].map((value) => String(value || '').match(/\d{6,}/)?.[0]).filter(Boolean))];
}

function emailFromText(text) {
  const match = String(text || '').match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  return match?.[0] || '';
}

function phoneFromText(text) {
  const matches = String(text || '').match(/(?:\+?\d[\d\s().-]{7,}\d)/g) || [];
  for (const value of matches) {
    const digits = value.replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 15) return value.replace(/\s+/g, ' ').trim();
  }
  return '';
}

function websiteFromText(text) {
  const matches = String(text || '').match(/https?:\/\/[^\s<>'")]+/gi) || [];
  return matches.find((url) => !/linkedin\.com/i.test(url)) || '';
}

function compactNumber(value) {
  const parsed = Number(String(value || '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function applicantCountFromText(text, company = '') {
  const source = String(text || '');
  const companyKey = String(company || '').trim();
  const index = companyKey ? source.toLowerCase().indexOf(companyKey.toLowerCase()) : -1;
  if (companyKey && index < 0) return '';
  const scoped = companyKey ? source.slice(Math.max(0, index - 350), index + companyKey.length + 900) : source;
  const match = scoped.match(/\b(\d[\d,]*\+?)\s+(?:people\s+clicked\s+apply|applicants?|applications?)\b/i);
  return match?.[1] || '';
}

function employeeCountFromText(text) {
  const source = String(text || '');
  const range = source.match(/\b(\d[\d,]*)\s*(?:-|–|to)\s*(\d[\d,]*)\s+employees?\b/i);
  if (range) return { min: compactNumber(range[1]), max: compactNumber(range[2]), label: `${range[1]}-${range[2]}` };
  const exact = source.match(/\b(?:company size|employees?)\s*[:·-]?\s*(\d[\d,]*)\+?\b/i)
    || source.match(/\b(\d[\d,]*)\+?\s+employees?\b/i);
  if (!exact) return null;
  const count = compactNumber(exact[1]);
  return count == null ? null : { min: count, max: count, label: exact[1] };
}

function passesEmployeeFilter(record, filters = {}) {
  if (filters.employeeMin == null && filters.employeeMax == null) return true;
  const size = record.employeeCount;
  if (!size) return false;
  if (filters.employeeMin != null && Number(size.max) < filters.employeeMin) return false;
  if (filters.employeeMax != null && Number(size.min) > filters.employeeMax) return false;
  return true;
}

const LOCATION_REGION_ALIASES = {
  maharashtra: [
    'maharashtra', 'mumbai', 'navi mumbai', 'thane', 'pune', 'nagpur', 'nashik',
    'aurangabad', 'chhatrapati sambhajinagar', 'kolhapur', 'solapur', 'amravati',
    'satara', 'sangli', 'jalgaon', 'akola', 'latur', 'ratnagiri',
  ],
};

function evidenceRegexEscape(value) {
  return String(value || '').replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
}

function containsEvidenceTerm(text, term) {
  const needle = String(term || '').trim();
  if (!needle) return false;
  return new RegExp(`\\b${evidenceRegexEscape(needle).replace(/\\ /g, '\\s+')}\\b`, 'i').test(String(text || ''));
}

function mergeEvidenceText(left, right, max = 12000) {
  const parts = [left, right].map((value) => String(value || '').trim()).filter(Boolean);
  return [...new Set(parts)].join('\n').slice(0, max);
}

function scopedCompanyEvidence(text, company, radius = 1400) {
  const source = String(text || '');
  const needle = String(company || '').trim();
  if (!source || !needle) return '';
  const lower = source.toLowerCase();
  const at = lower.indexOf(needle.toLowerCase());
  if (at < 0) return '';
  return source.slice(Math.max(0, at - radius), Math.min(source.length, at + needle.length + radius));
}

function detectWorkType(text) {
  const value = String(text || '');
  const patterns = [
    { value: 'remote', regex: /workplace\s+type\s*[:·-]?\s*remote\b/i },
    { value: 'hybrid', regex: /workplace\s+type\s*[:·-]?\s*hybrid\b/i },
    { value: 'on_site', regex: /workplace\s+type\s*[:·-]?\s*on[- ]?site\b/i },
    { value: 'remote', regex: /(?:^|\n)\s*remote\s*(?:$|\n)/im },
    { value: 'hybrid', regex: /(?:^|\n)\s*hybrid\s*(?:$|\n)/im },
    { value: 'on_site', regex: /(?:^|\n)\s*on[- ]?site\s*(?:$|\n)/im },
    { value: 'remote', regex: /\b(?:this|the)\s+(?:position|role|job)\s+is\s+(?:fully\s+)?remote\b/i },
    { value: 'hybrid', regex: /\b(?:this|the)\s+(?:position|role|job)\s+is\s+hybrid\b/i },
    { value: 'on_site', regex: /\b(?:this|the)\s+(?:position|role|job)\s+is\s+on[- ]?site\b/i },
    { value: 'remote', regex: /\bwork\s+from\s+(?:home|anywhere)\b/i },
  ];
  for (const item of patterns) if (item.regex.test(value)) return item.value;
  return '';
}

function companyLocationEvidence(record) {
  return [
    record?.companyEvidenceText,
    record?.companySearchEvidenceText,
    record?.companyLocation,
  ].filter(Boolean).join('\n');
}

function jobEvidence(record) {
  return [
    record?.role,
    record?.searchProvenance?.title,
    record?.jobEvidenceText,
    record?.hiringSignal,
  ].filter(Boolean).join('\n');
}

function locationLabelMatchesRequested(label, requestedLocation) {
  const requested = String(requestedLocation || '').trim().toLowerCase();
  const value = String(label || '').trim();
  if (!requested) return true;
  if (!value) return false;
  const aliases = LOCATION_REGION_ALIASES[requested] || [requested];
  return aliases.some((candidate) => containsEvidenceTerm(value, candidate));
}

function locationEvidenceDetails(record, requestedLocation, options = {}) {
  const requested = String(requestedLocation || '').trim().toLowerCase();
  if (!requested) return { matched: true, source: 'none', label: '' };
  const allowJobEvidence = Boolean(options.allowJobEvidence);
  const allowCompanyEvidence = options.allowCompanyEvidence == null ? !allowJobEvidence : Boolean(options.allowCompanyEvidence);
  const aliases = LOCATION_REGION_ALIASES[requested] || [requested];

  if (allowJobEvidence) {
    const explicit = jobEvidence(record);
    const alias = aliases.find((candidate) => containsEvidenceTerm(explicit, candidate));
    if (alias) return { matched: true, source: 'job', label: alias };

    const trustedLocations = Array.isArray(record?.searchProvenance?.trustedLocations)
      ? record.searchProvenance.trustedLocations
      : [];
    const trusted = trustedLocations.find((value) => locationLabelMatchesRequested(value, requested));
    if (trusted) return { matched: true, source: 'linkedin_search_filter', label: trusted };
  }

  if (allowCompanyEvidence) {
    const evidence = companyLocationEvidence(record);
    const alias = aliases.find((candidate) => containsEvidenceTerm(evidence, candidate));
    if (alias) return { matched: true, source: 'company', label: alias };
  }

  return { matched: false, source: '', label: '' };
}

function locationEvidenceMatches(record, requestedLocation, options = {}) {
  return locationEvidenceDetails(record, requestedLocation, options).matched;
}

function workTypeEvidenceDetails(record, requestedWorkType) {
  const requested = String(requestedWorkType || '').trim().toLowerCase();
  if (!requested) return { matched: true, source: 'none', value: '' };

  const explicit = detectWorkType(jobEvidence(record));
  if (explicit) return { matched: explicit === requested, source: 'job', value: explicit };

  const trusted = Array.isArray(record?.searchProvenance?.trustedWorkTypes)
    ? record.searchProvenance.trustedWorkTypes.map((value) => String(value || '').toLowerCase())
    : [];
  if (trusted.includes(requested)) return { matched: true, source: 'linkedin_search_filter', value: requested };

  return { matched: false, source: '', value: '' };
}

function workTypeEvidenceMatches(record, requestedWorkType) {
  return workTypeEvidenceDetails(record, requestedWorkType).matched;
}

function topicEvidenceMatches(record, topic) {
  const requested = String(topic || '').trim().toLowerCase();
  if (!requested || /^(?:companies|professionals)$/.test(requested)) return true;
  const evidence = jobEvidence(record);
  if (!evidence) return false;

  if (/^sap(?:\s|$)/i.test(requested)) {
    const rest = requested.replace(/^sap\s*/i, '').trim();
    const literalSap = containsEvidenceTerm(evidence, 'SAP');

    if (!rest) {
      if (literalSap) return true;
      const titleEvidence = [record?.role, record?.searchProvenance?.title].filter(Boolean).join(' ');
      if (/\b(?:ABAP|FICO|S\/?4HANA|HANA|SuccessFactors|Ariba)\b/i.test(titleEvidence)) return true;
      const keywords = Array.isArray(record?.searchProvenance?.keywords) ? record.searchProvenance.keywords : [];
      if (/\bBasis\b/i.test(titleEvidence) && keywords.some((value) => /^SAP\s+Basis$/i.test(String(value)))) return true;
      return false;
    }

    const knownModule = rest.match(/^(fico|mm|sd|abap|basis|s\/?4hana|successfactors|hana|bw|bpc|ariba|ewm|tm)\b/i);
    if (!knownModule) return literalSap;

    const module = knownModule[1];
    if (/^s\/?4hana$/i.test(module)) return /\bS\/?4HANA\b/i.test(evidence);
    if (containsEvidenceTerm(evidence, module)) return true;

    const titleEvidence = [record?.role, record?.searchProvenance?.title].filter(Boolean).join(' ');
    return containsEvidenceTerm(titleEvidence, module);
  }

  if (containsEvidenceTerm(evidence, requested)) return true;
  const stop = new Set(['role', 'roles', 'job', 'jobs', 'opening', 'openings', 'position', 'positions', 'hiring', 'in', 'from', 'at', 'near']);
  const tokens = requested
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9+#.-]/g, ''))
    .filter((token) => token.length >= 2 && !stop.has(token));
  return tokens.length > 0 && tokens.every((token) => containsEvidenceTerm(evidence, token));
}

function companyFilterFailures(record, request = {}) {
  const failures = [];
  if (request.hiring && !record?.hiringVerified) failures.push('hiring');
  if (!passesEmployeeFilter(record, request.filters || {})) failures.push('employee_count');
  if (request.location && !locationEvidenceMatches(record, request.location, {
    allowJobEvidence: Boolean(request.hiring),
    allowCompanyEvidence: request.locationScope !== 'job',
  })) failures.push('location');
  if (request.filters?.workType && !workTypeEvidenceMatches(record, request.filters.workType)) failures.push('work_type');
  if (request.hiring && request.topic && !topicEvidenceMatches(record, request.topic)) failures.push('topic');
  return [...new Set(failures)];
}

function passesCompanyHardFilters(record, request = {}) {
  return companyFilterFailures(record, request).length === 0;
}

function rejectedRecordSnapshot(record, reasons = [], request = {}) {
  const locationMatch = locationEvidenceDetails(record, request.location, {
    allowJobEvidence: Boolean(request.hiring),
    allowCompanyEvidence: request.locationScope !== 'job',
  });
  const jobLocation = linkedinPublic.locationFromText(record?.jobEvidenceText || '');
  const workTypeMatch = workTypeEvidenceDetails(record, request.filters?.workType);
  return {
    company: String(record?.company || record?.name || '').trim(),
    linkedin: String(record?.linkedin || '').trim(),
    location: locationMatch.source === 'job'
      ? (jobLocation || locationMatch.label || request.location || '')
      : (locationMatch.label || record?.companyLocation || linkedinPublic.locationFromText(record?.companySearchEvidenceText || '') || ''),
    locationEvidenceSource: locationMatch.source || '',
    workType: workTypeMatch.value || record?.workType || detectWorkType(record?.jobEvidenceText || ''),
    workTypeEvidenceSource: workTypeMatch.source || '',
    employeeCount: record?.employeeCount || null,
    applicants: record?.applicants || '',
    relevanceScore: Number(record?.relevanceScore || 0),
    hiringSignal: String(record?.hiringSignal || '').slice(0, 1000),
    jobEvidenceText: String(record?.jobEvidenceText || '').slice(0, 2500),
    companyEvidenceText: String(record?.companyEvidenceText || record?.companySearchEvidenceText || '').slice(0, 2500),
    rejectionReasons: [...new Set((reasons || []).map((value) => String(value || '').trim()).filter(Boolean))],
    sourceEvidence: [...new Set(record?.sourceEvidence || [])],
  };
}

function mergeDuplicateRecord(target, source) {
  if (!target || !source) return target || source;
  for (const key of ['name', 'company', 'role', 'jobId', 'jobUrl', 'website', 'applicants', 'email', 'phone', 'companyLocation']) {
    if (!target[key] && source[key]) target[key] = source[key];
  }
  for (const key of ['snippet', 'hiringSignal', 'jobEvidenceText', 'companySearchEvidenceText', 'companyEvidenceText']) {
    target[key] = mergeEvidenceText(target[key], source[key], key === 'snippet' ? 5000 : 12000);
  }
  if (!target.employeeCount && source.employeeCount) target.employeeCount = source.employeeCount;
  target.hiringVerified = Boolean(target.hiringVerified || source.hiringVerified);
  target.relevanceScore = Math.max(Number(target.relevanceScore || 0), Number(source.relevanceScore || 0));
  target.sourceEvidence = [...new Set([...(target.sourceEvidence || []), ...(source.sourceEvidence || [])])];
  return target;
}

function isBudgetStop(error) {
  return /LINKEDIN_(?:BURST|HOURLY|DAILY)_CAP/.test(String(error?.code || ''));
}

function missionCallBudget() {
  const safety = policy.status();
  const maximum = safety.localBudgetBypass
    ? Math.max(1, Number(safety.testMissionToolMax || safety.missionToolMax || 1))
    : Math.max(0, Math.min(
      safety.missionToolMax,
      safety.burstMax - safety.burstUsed,
      safety.hourlyMax - safety.hourlyUsed,
      safety.dailyMax - safety.dailyUsed,
    ));
  return { maximum, used: 0, stopped: null, localBudgetBypass: Boolean(safety.localBudgetBypass) };
}

async function budgetedCall(budget, tool, args) {
  if (budget.used >= budget.maximum) {
    budget.stopped = budget.stopped || 'mission LinkedIn-call budget reached';
    return null;
  }
  try {
    const result = await mcp.callTool(tool, args);
    budget.used++;
    return result;
  } catch (error) {
    if (isBudgetStop(error)) {
      budget.stopped = error.message;
      return null;
    }
    throw error;
  }
}

function referenceRecord(ref, request) {
  const snippet = [ref.text, ref.context].filter(Boolean).join(' · ').trim();
  if (request.entityMode === 'company') {
    const parsed = linkedinPublic.parseResult({
      title: ref.text || ref.slug,
      snippet,
      url: ref.url,
    }, { entityMode: 'company' });
    return parsed ? { ...parsed, name: '', company: parsed.company || parsed.name || '', source: parsed.linkedin, sourceEvidence: ['linkedin-account-search'] } : null;
  }
  const parsed = linkedinPublic.parseResult({
    title: ref.text || ref.slug,
    snippet,
    url: ref.url,
  }, { entityMode: 'person', location: request.location });
  return parsed ? { ...parsed, source: parsed.linkedin, sourceEvidence: ['linkedin-account-search'] } : null;
}

function qualityScore(record, request, evidence = {}) {
  let score = 45;
  const text = `${record.name || ''} ${record.company || ''} ${record.role || ''} ${record.snippet || ''}`.toLowerCase();
  const tokens = String(request.topic || '').toLowerCase().split(/\s+/).filter((x) => x.length >= 3);
  score += Math.min(25, tokens.filter((token) => text.includes(token)).length * 7);
  if (request.location && text.includes(request.location.toLowerCase())) score += 12;
  if (evidence.hiring) score += 20;
  if (evidence.deep) score += 8;
  return Math.max(0, Math.min(100, score));
}

function dedupeRecords(records, mode) {
  const byUrl = new Map();
  const byName = new Map();
  const out = [];
  for (const record of records || []) {
    const normalized = linkedinPublic.normalizeLinkedInEntityUrl(record?.linkedin, mode);
    if (!normalized) continue;
    const secondary = String(record.company || record.name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const existing = byUrl.get(normalized.url) || (secondary ? byName.get(secondary) : null);
    if (existing) {
      mergeDuplicateRecord(existing, { ...record, linkedin: normalized.url });
      continue;
    }
    const next = { ...record, linkedin: normalized.url };
    byUrl.set(normalized.url, next);
    if (secondary) byName.set(secondary, next);
    out.push(next);
  }
  return out;
}

function searchKeyword(request) {
  const topic = String(request.topic || '').trim();
  return topic && !/^(?:companies|professionals)$/i.test(topic) ? topic : (request.entityMode === 'company' ? 'technology' : 'professional');
}

function sapRoleKeywordVariants(topic) {
  const base = String(topic || '').trim();
  if (!/^sap$/i.test(base)) return [base].filter(Boolean);
  return [
    'SAP',
    'SAP Consultant',
    'SAP FICO',
    'SAP ABAP',
    'SAP MM',
    'SAP SD',
    'SAP Basis',
    'SAP S/4HANA',
    'SAP SuccessFactors',
  ];
}

function jobSearchPlan(request) {
  const keywords = sapRoleKeywordVariants(searchKeyword(request));
  const location = String(request.location || '').trim();
  const plan = [];
  const add = (keyword, loc) => {
    const key = `${String(keyword || '').trim().toLowerCase()}|${String(loc || '').trim().toLowerCase()}`;
    if (!keyword || plan.some((item) => item.key === key)) return;
    plan.push({ key, keyword: String(keyword).trim(), location: String(loc || '').trim() || null });
  };

  if (/^maharashtra$/i.test(location) && /^sap$/i.test(String(request.topic || ''))) {
    add('SAP', 'Maharashtra');
    add('SAP', 'Pune');
    add('SAP', 'Mumbai');
    add('SAP', 'Navi Mumbai');
    add('SAP', 'Nagpur');
    add('SAP', 'Thane');
    add('SAP', 'Nashik');
    add('SAP Consultant', 'Maharashtra');
    add('SAP FICO', 'Maharashtra');
    add('SAP ABAP', 'Maharashtra');
    add('SAP S/4HANA', 'Maharashtra');
    add('SAP SuccessFactors', 'Maharashtra');
    add('SAP MM', 'Maharashtra');
    add('SAP SD', 'Maharashtra');
    add('SAP Basis', 'Maharashtra');
  } else {
    add(keywords[0], location || null);
    for (const keyword of keywords.slice(1)) add(keyword, location || null);
  }

  return plan.map(({ key, ...item }) => item);
}

function droppedSearchFilters(result) {
  const warning = result?.section_errors?.search_results || null;
  const text = `${warning?.error_type || ''} ${warning?.error_message || ''}`.toLowerCase();
  if (!/filters?_dropped|did not keep/.test(text)) return new Set();
  const dropped = new Set();
  const rules = [
    ['location', /\blocation\b/],
    ['work_type', /\bwork[_ ]?type\b|\bworkplace\b|\bf_wt\b/],
    ['date_posted', /\bdate[_ ]?posted\b|\bposting date\b|\bf_tpr\b/],
    ['job_type', /\bjob[_ ]?type\b|\bf_jt\b/],
    ['experience_level', /\bexperience[_ ]?level\b|\bf_e\b/],
    ['easy_apply', /\beasy[_ ]?apply\b|\bf_ea\b/],
  ];
  for (const [name, regex] of rules) if (regex.test(text)) dropped.add(name);
  return dropped;
}

function searchFilterTrust(result, step, request) {
  const dropped = droppedSearchFilters(result);
  return {
    dropped: [...dropped],
    trustedLocation: step?.location && !dropped.has('location') ? String(step.location) : '',
    trustedWorkType: request?.filters?.workType && !dropped.has('work_type') ? String(request.filters.workType) : '',
  };
}

function jobReferenceMap(result) {
  const map = new Map();
  for (const ref of collectReferences(result)) {
    const match = String(ref.url || '').match(/\/jobs\/view\/(?:[^\d/]*-)?(\d{6,})/i);
    if (!match) continue;
    const id = match[1];
    const current = map.get(id) || { id, title: '', context: '', url: '' };
    if (!current.title && ref.text) current.title = String(ref.text).trim();
    if (!current.context && ref.context) current.context = String(ref.context).trim();
    if (!current.url && ref.url) current.url = absoluteLinkedInUrl(ref.url);
    map.set(id, current);
  }
  return map;
}

function jobIdPriority(meta = {}) {
  let score = 0;
  const title = String(meta.title || '');
  const keyword = String(meta.bestKeyword || '');
  const locations = Array.isArray(meta.locations) ? meta.locations : [];
  if (/\bSAP\b/i.test(title)) score += 60;
  if (/\b(?:FICO|ABAP|S\/4HANA|S4HANA|SuccessFactors|Basis)\b/i.test(title)) score += 18;
  if (/\bSAP\b/i.test(keyword)) score += 8;
  if (/\b(?:FICO|ABAP|MM|SD|Basis|S\/4HANA|SuccessFactors)\b/i.test(keyword)) score += 10;
  if (locations.some((value) => /^(?:Pune|Mumbai|Navi Mumbai)$/i.test(String(value)))) score += 14;
  score += Math.max(0, Number(meta.hits || 1) - 1) * 12;
  score += Math.max(0, 12 - Number(meta.firstRank || 12));
  return score;
}

function prioritizedJobIds(jobMeta) {
  return [...jobMeta.values()]
    .sort((a, b) => jobIdPriority(b) - jobIdPriority(a) || Number(a.firstSeen || 0) - Number(b.firstSeen || 0))
    .map((item) => item.id);
}

function jobLevelFailures(record, request = {}) {
  const failures = [];
  if (request.hiring && !record?.hiringVerified) failures.push('hiring');
  if (request.location && !locationEvidenceMatches(record, request.location, {
    allowJobEvidence: true,
    allowCompanyEvidence: request.locationScope === 'company',
  })) failures.push('location');
  if (request.filters?.workType && !workTypeEvidenceMatches(record, request.filters.workType)) failures.push('work_type');
  if (request.hiring && request.topic && !topicEvidenceMatches(record, request.topic)) failures.push('topic');
  return [...new Set(failures)];
}

function jobTitleFromDetail(detail, fallback = '') {
  const raw = String(detail?.sections?.job_posting || '').trim();
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const ignored = /^(?:about the job|job description|show more|save|apply|easy apply)$/i;
  const title = lines.find((line) => line.length >= 3 && line.length <= 140 && !ignored.test(line));
  return title || String(fallback || '').trim();
}

async function callPrimaryWithExactFallback(tool, args, fallback = null) {
  try {
    return await mcp.callTool(tool, args);
  } catch (error) {
    const eligible = fallback && joeyism.enabled()
      && /LINKEDIN_MCP_|auth|session|browser|profile/i.test(`${error.code || ''} ${error.message || ''}`);
    if (!eligible) throw error;
    return joeyism.call(fallback.action, fallback.args);
  }
}

async function companyMission(request) {
  const records = [];
  const budget = missionCallBudget();
  if (budget.maximum < 1) {
    const error = new Error('No LinkedIn account calls remain in the current short-window/hourly/daily safety budget. Wait for the displayed safety window before starting another mission.');
    error.code = 'LINKEDIN_BURST_CAP';
    throw error;
  }

  let jobDetails = 0;
  let jobIdsDiscovered = 0;
  let jobCandidatesLinked = 0;
  let jobCandidatesPassed = 0;
  let deepProfiles = 0;
  let verifiedDuringRun = 0;
  const searchCalls = [];
  const searchWarnings = [];
  const jobMeta = new Map();
  const profileCheckedCompanies = new Map();

  if (request.hiring) {
    const plan = jobSearchPlan(request);
    const maxSearchCalls = budget.localBudgetBypass ? Math.min(plan.length, 12) : 1;

    for (const step of plan.slice(0, maxSearchCalls)) {
      const result = await budgetedCall(budget, 'search_jobs', {
        keywords: step.keyword,
        location: step.location || undefined,
        max_pages: budget.localBudgetBypass ? Math.max(2, Math.min(3, policy.settings().maxJobPages + 1)) : policy.settings().maxJobPages,
        date_posted: request.filters?.datePosted || undefined,
        job_type: request.filters?.jobType || undefined,
        experience_level: request.filters?.experienceLevel || undefined,
        work_type: request.filters?.workType || undefined,
        easy_apply: Boolean(request.filters?.easyApply),
        sort_by: 'relevance',
      });
      if (!result) break;

      const ids = jobIdsFromResult(result);
      const refs = jobReferenceMap(result);
      const warning = result?.section_errors?.search_results || null;
      const trust = searchFilterTrust(result, step, request);
      if (warning?.error_message) {
        searchWarnings.push({ keyword: step.keyword, location: step.location, ...warning });
      }

      ids.forEach((id, rank) => {
        const ref = refs.get(id) || {};
        const current = jobMeta.get(id) || {
          id,
          title: '',
          hits: 0,
          locations: [],
          trustedLocations: [],
          trustedWorkTypes: [],
          keywords: [],
          searches: [],
          bestKeyword: '',
          firstRank: rank,
          firstSeen: jobMeta.size,
        };
        current.hits += 1;
        current.firstRank = Math.min(Number(current.firstRank ?? rank), rank);
        if (!current.title && ref.title) current.title = ref.title;
        if (step.location && !current.locations.includes(step.location)) current.locations.push(step.location);
        if (trust.trustedLocation && !current.trustedLocations.includes(trust.trustedLocation)) current.trustedLocations.push(trust.trustedLocation);
        if (trust.trustedWorkType && !current.trustedWorkTypes.includes(trust.trustedWorkType)) current.trustedWorkTypes.push(trust.trustedWorkType);
        if (step.keyword && !current.keywords.includes(step.keyword)) current.keywords.push(step.keyword);
        current.searches.push({
          keyword: step.keyword,
          location: step.location || '',
          requestedWorkType: request.filters?.workType || '',
          trustedLocation: trust.trustedLocation,
          trustedWorkType: trust.trustedWorkType,
          dropped: trust.dropped,
        });
        if (!current.bestKeyword || String(step.keyword).length > String(current.bestKeyword).length) current.bestKeyword = step.keyword;
        jobMeta.set(id, current);
      });

      searchCalls.push({
        keyword: step.keyword,
        location: step.location,
        jobIds: ids.length,
        uniqueJobIds: jobMeta.size,
        trustedLocation: trust.trustedLocation || null,
        trustedWorkType: trust.trustedWorkType || null,
        droppedFilters: trust.dropped,
        warning: warning?.error_type || null,
      });
    }

    jobIdsDiscovered = jobMeta.size;
    const orderedJobIds = prioritizedJobIds(jobMeta);
    const acceptedCompanies = new Set();

    for (const jobId of orderedJobIds) {
      if (acceptedCompanies.size >= request.count) break;
      if (budget.used >= budget.maximum) {
        budget.stopped = budget.stopped || 'mission LinkedIn-call budget reached';
        break;
      }

      const detail = await budgetedCall(budget, 'get_job_details', { job_id: jobId });
      if (!detail) break;
      jobDetails++;

      const detailText = flattenText(detail);
      const companyRefs = linkedInReferences(detail, 'company');
      const preferred = companyRefs.find((ref) => /job posting|job/i.test(String(ref.context || '')))
        || companyRefs.find((ref) => String(ref.kind || '').toLowerCase() === 'company')
        || companyRefs[0];
      if (!preferred) continue;

      const record = referenceRecord(preferred, request);
      if (!record) continue;

      const meta = jobMeta.get(jobId) || {};
      record.jobId = String(jobId);
      record.jobUrl = `https://www.linkedin.com/jobs/view/${jobId}`;
      record.role = jobTitleFromDetail(detail, meta.title || '');
      record.jobEvidenceText = detailText;
      record.hiringSignal = detailText.slice(0, 1000) || `Verified LinkedIn job ${jobId}.`;
      record.hiringVerified = Boolean(detailText && preferred);
      record.workType = detectWorkType(detailText);
      record.applicants = applicantCountFromText(detailText, record.company);
      record.relevanceScore = qualityScore(record, request, { hiring: record.hiringVerified, deep: true });
      record.searchProvenance = {
        title: meta.title || '',
        hits: Number(meta.hits || 0),
        keywords: meta.keywords || [],
        locations: meta.locations || [],
        trustedLocations: meta.trustedLocations || [],
        trustedWorkTypes: meta.trustedWorkTypes || [],
        searches: meta.searches || [],
        priority: jobIdPriority(meta),
      };
      record.sourceEvidence = [...new Set([...(record.sourceEvidence || []), `linkedin-job-${jobId}`, 'linkedin-job-detail'])];
      jobCandidatesLinked++;

      const jobFailures = jobLevelFailures(record, request);
      if (jobFailures.length) {
        record.preProfileFailures = jobFailures;
        records.push(record);
        continue;
      }

      jobCandidatesPassed++;

      const normalizedCompany = linkedinPublic.normalizeLinkedInEntityUrl(record.linkedin, 'company');
      const companyKey = normalizedCompany?.slug || String(record.company || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (!companyKey) {
        records.push(record);
        continue;
      }

      const existingCompany = profileCheckedCompanies.get(companyKey);
      if (existingCompany) {
        // Another individually-valid SAP job at a company we already checked.
        // Keep the stronger job evidence without paying for the profile twice.
        if (Number(record.relevanceScore || 0) > Number(existingCompany.relevanceScore || 0)) {
          mergeDuplicateRecord(existingCompany, record);
        }
        continue;
      }

      if (budget.used >= budget.maximum) {
        records.push(record);
        budget.stopped = budget.stopped || 'mission LinkedIn-call budget reached before company-profile verification';
        break;
      }

      try {
        const deep = await budgetedCall(budget, 'get_company_profile', { company_name: normalizedCompany?.slug || record.company });
        if (!deep) {
          records.push(record);
          break;
        }
        deepProfiles++;
        const text = flattenText(deep);
        record.companyEvidenceText = text;
        record.snippet = [record.snippet, text.slice(0, 3500)].filter(Boolean).join('\n').slice(0, 5000);
        record.website = websiteFromText(text);
        record.email = '';
        record.phone = '';
        record.employeeCount = employeeCountFromText(text) || record.employeeCount || null;
        record.companyLocation = linkedinPublic.locationFromText(text) || '';
        record.applicants = record.applicants || applicantCountFromText(record.jobEvidenceText, record.company);
        record.relevanceScore = qualityScore(record, request, { hiring: true, deep: true });
        record.sourceEvidence = [...new Set([...(record.sourceEvidence || []), 'linkedin-account-company-profile'])];
      } catch (error) {
        if (error.code === 'LINKEDIN_COOLDOWN_ACTIVE' || error.code === 'LINKEDIN_MANUAL_LOCK') throw error;
        record.deepError = error.message;
      }

      profileCheckedCompanies.set(companyKey, record);
      records.push(record);

      if (companyFilterFailures(record, request).length === 0) {
        acceptedCompanies.add(companyKey);
        verifiedDuringRun = acceptedCompanies.size;
      }
    }
  } else {
    const keyword = searchKeyword(request);
    const searches = [keyword, request.location ? `${keyword} ${request.location}` : ''].filter(Boolean);
    for (const query of [...new Set(searches)].slice(0, 2)) {
      const result = await budgetedCall(budget, 'search_companies', { keywords: query });
      if (!result) break;
      for (const ref of linkedInReferences(result, 'company')) {
        const record = referenceRecord(ref, request);
        if (!record) continue;
        record.companySearchEvidenceText = [ref.text, ref.context].filter(Boolean).join(' · ');
        record.employeeCount = employeeCountFromText(record.companySearchEvidenceText) || employeeCountFromText(record.snippet);
        record.relevanceScore = qualityScore(record, request);
        records.push(record);
      }
    }
  }

  const preProfileRejected = request.hiring
    ? records.filter((record) => jobLevelFailures(record, request).length > 0)
    : [];

  let merged = dedupeRecords(
    request.hiring
      ? records.filter((record) => jobLevelFailures(record, request).length === 0)
      : records,
    'company',
  ).sort((a, b) => Number(b.relevanceScore || 0) - Number(a.relevanceScore || 0));

  // Non-hiring missions still need bounded company-profile verification.
  if (!request.hiring) {
    const remainingForProfiles = Math.max(0, budget.maximum - budget.used);
    const deepMax = budget.localBudgetBypass
      ? Math.min(merged.length, request.count, remainingForProfiles)
      : Math.min(policy.settings().deepProfilesPerMission, merged.length, request.count, remainingForProfiles);
    for (let index = 0; index < deepMax; index++) {
      const record = merged[index];
      const slug = linkedinPublic.normalizeLinkedInEntityUrl(record.linkedin, 'company')?.slug;
      if (!slug) continue;
      try {
        const deep = await budgetedCall(budget, 'get_company_profile', { company_name: slug });
        if (!deep) break;
        deepProfiles++;
        const text = flattenText(deep);
        record.companyEvidenceText = text;
        record.employeeCount = employeeCountFromText(text) || record.employeeCount || null;
        record.companyLocation = linkedinPublic.locationFromText(text) || '';
        record.relevanceScore = qualityScore(record, request, { deep: true });
      } catch (error) {
        if (error.code === 'LINKEDIN_COOLDOWN_ACTIVE' || error.code === 'LINKEDIN_MANUAL_LOCK') throw error;
        record.deepError = error.message;
      }
    }
  }

  const candidateCountBeforeGate = merged.length + preProfileRejected.length;
  const rejected = {
    low_relevance: 0,
    hiring: 0,
    employee_count: 0,
    location: 0,
    work_type: 0,
    topic: 0,
  };
  const accepted = [];
  const rejectedRecords = [];
  let rejectedCandidates = 0;

  for (const record of preProfileRejected) {
    const failures = jobLevelFailures(record, request);
    rejectedCandidates++;
    for (const reason of failures) rejected[reason] = Number(rejected[reason] || 0) + 1;
    rejectedRecords.push(rejectedRecordSnapshot(record, failures, request));
  }

  for (const record of merged) {
    const failures = companyFilterFailures(record, request);
    if (failures.length) {
      rejectedCandidates++;
      for (const reason of failures) rejected[reason] = Number(rejected[reason] || 0) + 1;
      rejectedRecords.push(rejectedRecordSnapshot(record, failures, request));
      continue;
    }

    const locationMatch = locationEvidenceDetails(record, request.location, {
      allowJobEvidence: Boolean(request.hiring),
      allowCompanyEvidence: request.locationScope !== 'job',
    });
    const jobLocation = linkedinPublic.locationFromText(record.jobEvidenceText);
    record.location = ['job', 'linkedin_search_filter'].includes(locationMatch.source)
      ? (jobLocation || locationMatch.label || request.location || '')
      : (record.companyLocation || linkedinPublic.locationFromText(record.companySearchEvidenceText) || locationMatch.label || '');
    record.locationEvidenceSource = locationMatch.source;
    const workTypeMatch = workTypeEvidenceDetails(record, request.filters?.workType);
    record.workType = workTypeMatch.value || detectWorkType(record.jobEvidenceText);
    record.workTypeEvidenceSource = workTypeMatch.source;
    accepted.push(record);
  }

  merged = accepted
    .sort((a, b) => Number(b.relevanceScore || 0) - Number(a.relevanceScore || 0))
    .slice(0, request.count);

  return {
    records: merged,
    toolCalls: {
      searchJobs: searchCalls.length,
      searchPlan: searchCalls,
      parsedTopic: request.topic,
      jobIdsDiscovered,
      jobDetails,
      jobCandidatesLinked,
      jobCandidatesPassed,
      deepCompanyProfiles: deepProfiles,
      verifiedDuringRun,
      total: budget.used,
      maximum: budget.maximum,
    },
    budgetStopped: budget.stopped,
    filters: request.filters,
    linkedinSearchWarnings: searchWarnings,
    filterVerification: {
      hardGate: true,
      requestedLocation: request.location || null,
      locationScope: request.locationScope || null,
      requestedWorkType: request.filters?.workType || null,
      employeeMin: request.filters?.employeeMin ?? null,
      employeeMax: request.filters?.employeeMax ?? null,
      topic: request.topic || null,
      rejected,
      rejectedCandidates,
      candidateCount: candidateCountBeforeGate,
    },
    rejectedRecords,
  };
}

async function personMission(request) {
  const keyword = searchKeyword(request);
  const results = [];
  const queries = [keyword];
  if (request.hiring && !/recruit|talent|hr/i.test(keyword)) queries.push(`${keyword} recruiter`);

  for (const query of [...new Set(queries)].slice(0, 2)) {
    const search = await mcp.callTool('search_people', {
      keywords: query,
      location: request.location || undefined,
    });
    for (const ref of linkedInReferences(search, 'person')) {
      const record = referenceRecord(ref, request);
      if (!record) continue;
      record.relevanceScore = qualityScore(record, request);
      results.push(record);
    }
  }

  let merged = dedupeRecords(results, 'person')
    .sort((a, b) => Number(b.relevanceScore || 0) - Number(a.relevanceScore || 0));

  const deepMax = Math.min(policy.settings().deepProfilesPerMission, merged.length, request.count);
  for (let index = 0; index < deepMax; index++) {
    const record = merged[index];
    const slug = linkedinPublic.normalizeLinkedInEntityUrl(record.linkedin, 'person')?.slug;
    if (!slug) continue;
    try {
      const deep = await mcp.callTool('get_person_profile', {
        linkedin_username: slug,
        sections: request.wantsContacts ? 'experience,contact_info' : 'experience',
        max_scrolls: 5,
      });
      const text = flattenText(deep);
      record.snippet = [record.snippet, text.slice(0, 3500)].filter(Boolean).join('\n').slice(0, 5000);
      if (request.wantsContacts) {
        record.email = emailFromText(text);
        record.phone = phoneFromText(text);
      }
      record.relevanceScore = qualityScore(record, request, { deep: true });
      record.sourceEvidence = [...new Set([...(record.sourceEvidence || []), 'linkedin-account-person-profile'])];
    } catch (error) {
      if (error.code === 'LINKEDIN_COOLDOWN_ACTIVE' || error.code === 'LINKEDIN_MANUAL_LOCK') throw error;
      record.deepError = error.message;
    }
  }

  merged = merged
    .filter((record) => Number(record.relevanceScore || 0) >= 45)
    .sort((a, b) => Number(b.relevanceScore || 0) - Number(a.relevanceScore || 0))
    .slice(0, request.count);

  return {
    records: merged,
    toolCalls: { searchPeople: Math.min(2, queries.length), deepPersonProfiles: deepMax },
  };
}

async function exactMission(request) {
  if (request.entityMode === 'company') {
    const deep = await callPrimaryWithExactFallback('get_company_profile', {
      company_name: request.exactSlug,
      sections: request.hiring ? 'posts,jobs' : 'posts',
    }, { action: 'company', args: { url: request.exactUrl } });
    const text = flattenText(deep);
    const company = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line && line.length < 120) || request.exactSlug;
    return {
      records: [{
        entityType: 'company',
        name: company,
        company,
        linkedin: request.exactUrl,
        location: request.location,
        hiringSignal: request.hiring && /\b(?:hiring|jobs?|vacanc(?:y|ies)|openings?)\b/i.test(text) ? 'Hiring evidence found in LinkedIn company content.' : '',
        snippet: text.slice(0, 5000),
        website: websiteFromText(text),
        email: '',
        phone: '',
        source: request.exactUrl,
        relevanceScore: 90,
        sourceEvidence: ['linkedin-account-company-profile'],
      }],
      toolCalls: { deepCompanyProfiles: 1 },
    };
  }
  const deep = await callPrimaryWithExactFallback('get_person_profile', {
    linkedin_username: request.exactSlug,
    sections: request.wantsContacts ? 'experience,education,contact_info' : 'experience,education',
    max_scrolls: 5,
  }, { action: 'person', args: { url: request.exactUrl } });
  const text = flattenText(deep);
  const first = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line && line.length < 120) || request.exactSlug;
  return {
    records: [{
      entityType: 'person',
      name: first,
      company: '',
      role: '',
      linkedin: request.exactUrl,
      location: request.location,
      snippet: text.slice(0, 5000),
      email: request.wantsContacts ? emailFromText(text) : '',
      phone: request.wantsContacts ? phoneFromText(text) : '',
      source: request.exactUrl,
      relevanceScore: 90,
      sourceEvidence: ['linkedin-account-person-profile'],
    }],
    toolCalls: { deepPersonProfiles: 1 },
  };
}

async function apiRequest(url, options = {}) {
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
  if (!response.ok) throw new Error(data?.error?.message || `Google Sheets API failed (${response.status}).`);
  return data;
}

async function appendRows(spreadsheetId, sheetName, rows) {
  if (!rows.length) return 0;
  const full = `${sheets.quoteSheet(sheetName)}!A:ZZ`;
  const result = await apiRequest(`${API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(full)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    body: JSON.stringify({ majorDimension: 'ROWS', values: rows }),
  });
  return Number(result?.updates?.updatedRows || rows.length);
}

async function hideInternalContactColumn(spreadsheetId, sheetId, columnIndex) {
  if (!Number.isInteger(sheetId) || !Number.isInteger(columnIndex)) return false;
  await apiRequest(`${API}/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests: [{
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: columnIndex, endIndex: columnIndex + 1 },
        properties: { hiddenByUser: true },
        fields: 'hiddenByUser',
      },
    }] }),
  });
  return true;
}

function websiteDomain(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try { return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

function rejectedSheetHeaders() {
  return [
    'COMPANY NAME',
    'COMPANY LINK',
    'SAP ROLE',
    'JOB LINK',
    'LOCATION',
    'LOCATION EVIDENCE',
    'WORK TYPE',
    'EMPLOYEES',
    'NO. OF APPLICANTS',
    'LEAD SCORE',
    'REJECTION REASONS',
    'HIRING SIGNAL',
    'JOB EVIDENCE',
    'COMPANY EVIDENCE',
  ];
}

function rejectedSheetRow(record) {
  return [
    record?.company || '',
    record?.linkedin || '',
    record?.role || '',
    record?.jobUrl || '',
    record?.location || '',
    record?.locationEvidenceSource || '',
    record?.workType || '',
    record?.employeeCount?.label || '',
    record?.applicants || '',
    record?.relevanceScore ?? '',
    Array.isArray(record?.rejectionReasons) ? record.rejectionReasons.join(', ') : '',
    record?.hiringSignal || '',
    record?.jobEvidenceText || '',
    record?.companyEvidenceText || '',
  ];
}

function latestRejectedMission() {
  return [...loadState().missions].reverse().find((mission) =>
    mission?.status === 'completed'
    && mission?.request?.entityMode === 'company'
    && mission?.filterVerification?.hardGate
    && Number(mission?.filterVerification?.rejectedCandidates || 0) > 0
  ) || null;
}

function isRejectedSheetRequest(text) {
  const value = String(text || '').trim();
  if (!/\b(?:sheet|spreadsheet|google\s+sheet)\b/i.test(value)) return false;
  if (/\b(?:rejected|failed|filtered\s*out|excluded|disqualified)\b/i.test(value)) return true;
  if (/\bthose\b[\s\S]{0,25}\b(?:candidates?|companies|results?|leads?)\b/i.test(value)) {
    return Boolean(latestRejectedMission());
  }
  return false;
}

async function createRejectedCandidatesSheet() {
  const state = loadState();
  const mission = [...state.missions].reverse().find((item) =>
    item?.status === 'completed'
    && item?.request?.entityMode === 'company'
    && item?.filterVerification?.hardGate
    && Number(item?.filterVerification?.rejectedCandidates || 0) > 0
  );
  if (!mission) {
    const error = new Error('No completed LinkedIn company mission with rejected candidates is available.');
    error.code = 'LINKEDIN_REJECTED_MISSION_NOT_FOUND';
    throw error;
  }

  const rejectedRecords = Array.isArray(mission.rejectedRecords) ? mission.rejectedRecords : [];
  if (!rejectedRecords.length) {
    return {
      ok: false,
      legacyMissing: true,
      missionId: mission.id,
      rejectedCandidates: Number(mission.filterVerification?.rejectedCandidates || 0),
      message: 'That mission recorded only rejection counts, not the rejected candidate rows. The exact old candidates cannot be reconstructed without rerunning the LinkedIn mission.',
    };
  }

  const headers = rejectedSheetHeaders();
  const topic = String(mission.request?.topic || 'Candidates').replace(/[^a-z0-9 ()&+._-]+/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 50);
  const title = `ULTRON LinkedIn Rejected - ${topic} - ${new Date().toISOString().slice(0, 10)}`;
  const created = await v2.createSpreadsheet(title, headers, rejectedRecords.length);
  const added = await appendRows(created.spreadsheetId, created.sheetName, rejectedRecords.map(rejectedSheetRow));

  mission.rejectedSheetUrl = created.url;
  mission.rejectedSheetName = created.sheetName;
  mission.rejectedSheetTitle = created.title;
  mission.rejectedSheetAdded = added;
  mission.rejectedSheetCreatedAt = nowIso();
  saveState(state);

  return {
    ok: true,
    missionId: mission.id,
    sheetUrl: created.url,
    sheetName: created.sheetName,
    spreadsheetTitle: created.title,
    added,
    rejectedCandidates: rejectedRecords.length,
  };
}

function apolloSearchDelayMs() {
  const value = Number(apollo.setting('ULTRON_M3_APOLLO_PEOPLE_SEARCH_DELAY_MS', '900'));
  return Math.max(300, Math.min(10000, Number.isFinite(value) ? value : 900));
}

function contactRemark(name, role) {
  const person = String(name || '').trim();
  const title = String(role || '').trim();
  if (!person) return '';
  return title ? `${person} (${title})` : person;
}

async function prepareApolloCompanyContacts(missionId) {
  const state = loadState();
  const mission = state.missions.find((item) => item.id === missionId);
  if (!mission?.sheetUrl || mission.request?.entityMode !== 'company') {
    const error = new Error('The LinkedIn company mission is no longer available for Apollo decision-maker enrichment.');
    error.code = 'LINKEDIN_APOLLO_MISSION_NOT_FOUND';
    throw error;
  }
  const targets = Array.isArray(mission.contactTargets) ? mission.contactTargets : [];
  const max = Math.max(1, Math.min(100, Number(apollo.setting('ULTRON_M3_APOLLO_COMPANY_SEARCH_MAX', '50')) || 50));
  const changes = [];
  const selected = [];
  const unresolved = [];
  const nameIndex = mission.headers.findIndex((header) => headerKey(header) === 'name');
  const remarksIndex = mission.headers.findIndex((header) => headerKey(header) === 'remarks');
  const helperIndex = mission.storageHeaders.findIndex((header) => headerKey(header) === 'contactLinkedin');
  const spreadsheetId = sheets.spreadsheetId(mission.sheetUrl);

  for (const target of targets.slice(0, max)) {
    try {
      const result = await apollo.searchCompanyDecisionMaker({
        company: target.company,
        domain: target.domain,
        priorityMode: mission.request?.hiring ? 'hiring' : 'general',
      });
      const person = result.candidate;
      if (!person) {
        unresolved.push({ company: target.company, reason: 'No Apollo candidate matched the company and requested priority titles.' });
      } else {
        const name = String(person.name || [person.first_name, person.last_name].filter(Boolean).join(' ') || '').trim();
        const remark = contactRemark(name, person.title);
        if (nameIndex >= 0) changes.push({ range: sheets.cellRange(mission.sheetName, target.rowNumber, nameIndex), value: name });
        if (remarksIndex >= 0) changes.push({ range: sheets.cellRange(mission.sheetName, target.rowNumber, remarksIndex), value: remark });
        if (helperIndex >= 0) changes.push({ range: sheets.cellRange(mission.sheetName, target.rowNumber, helperIndex), value: person.linkedinUrl });
        selected.push({ rowNumber: target.rowNumber, company: target.company, name, title: person.title || '', remark, linkedin: person.linkedinUrl, priority: person.decisionPriority });
      }
    } catch (error) {
      if (/APOLLO_(?:PEOPLE_SEARCH_ACCESS_REQUIRED|NOT_CONFIGURED)/.test(String(error.code || '')) || Number(error.status) === 429) throw error;
      unresolved.push({ company: target.company, reason: error.message });
    }
    await new Promise((resolve) => setTimeout(resolve, apolloSearchDelayMs()));
  }
  if (changes.length) await sheets.writeCells(spreadsheetId, changes);
  mission.apolloDecisionMakers = selected;
  mission.apolloDecisionMakerUnresolved = unresolved;
  mission.apolloDecisionMakerPreparedAt = nowIso();
  saveState(state);
  return { mission, selected: selected.length, unresolved: unresolved.length };
}

function rowFor(record, headers) {
  return headers.map((header) => {
    const key = headerKey(header);
    if (key === 'name') return record.name || '';
    if (key === 'company') return record.company || '';
    if (key === 'role') return record.role || '';
    if (key === 'jobLink') return record.jobUrl || '';
    if (key === 'linkedin') return record.linkedin || '';
    if (key === 'contactLinkedin') return record.contactLinkedin || '';
    if (key === 'location') return record.location || record.companyLocation || '';
    if (key === 'workType') return record.workType || detectWorkType(record.jobEvidenceText) || '';
    if (key === 'employees') return record.employeeCount?.label || '';
    if (key === 'hiring') return record.hiringSignal || '';
    if (key === 'details') return record.snippet || '';
    if (key === 'website') return record.website || '';
    if (key === 'phone') return record.phone || '';
    if (key === 'email') return record.email || '';
    if (key === 'remarks') return record.remarks || contactRemark(record.name, record.role);
    if (key === 'applicants') return record.applicants || '';
    if (key === 'source') return record.source || record.linkedin || '';
    if (key === 'score') return record.relevanceScore ?? '';
    return '';
  });
}

async function run(request, headers) {
  const mission = {
    id: `linkedin-account-${Date.now()}`,
    createdAt: nowIso(),
    status: 'running',
    request: { ...request, explicitHeaders: undefined },
    headers,
    linkedinOnly: true,
    primaryBackend: 'stickerdaniel/linkedin-mcp-server',
    fallbackBackend: joeyism.enabled() ? 'joeyism/linkedin_scraper (exact URL fallback only)' : 'disabled',
  };
  const state = loadState();
  state.pending = null;
  state.missions.push(mission);
  saveState(state);

  try {
    const researched = request.exactUrl
      ? await exactMission(request)
      : request.entityMode === 'company'
        ? await companyMission(request)
        : await personMission(request);

    const title = `ULTRON LinkedIn - ${String(request.topic || request.entityMode).replace(/[^a-z0-9 ()&+._-]+/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 65)} - ${new Date().toISOString().slice(0, 10)}`;
    const needsInternalContact = request.entityMode === 'company' && request.wantsContacts;

    let destination = null;
    let outputHeaders = ensureHeaders(headers, request);
    if (request.destinationSheetUrl) {
      destination = await inspectDestinationSheet(request.destinationSheetUrl, request);
      outputHeaders = ensureHeaders(destination.headers, request);
    }

    const storageHeaders = [...outputHeaders];
    if (needsInternalContact && !storageHeaders.some((header) => headerKey(header) === 'contactLinkedin')) {
      storageHeaders.push(INTERNAL_CONTACT_HEADER);
    }

    let sheet;
    let recordsToWrite = researched.records.slice();
    let duplicateRowsSkipped = 0;
    let firstAppendedRow = 2;

    if (destination) {
      await syncDestinationHeaders(destination, storageHeaders);
      const existingKeys = destinationExistingKeys(destination, storageHeaders);
      recordsToWrite = researched.records.filter((record) => {
        const keys = recordDestinationKeys(record);
        const duplicate = keys.some((key) => existingKeys.has(key));
        if (!duplicate) for (const key of keys) existingKeys.add(key);
        return !duplicate;
      });
      duplicateRowsSkipped = researched.records.length - recordsToWrite.length;
      firstAppendedRow = Math.max(destination.lastNonEmptyRow + 1, destination.headerRowNumber + 1);
      sheet = {
        spreadsheetId: destination.spreadsheetId,
        sheetId: destination.sheetId,
        sheetName: destination.sheetName,
        title: destination.spreadsheetTitle,
        url: request.destinationSheetUrl,
        formatted: true,
      };
    } else {
      sheet = await v2.createSpreadsheet(title, storageHeaders, request.count);
      firstAppendedRow = 2;
    }

    const rows = recordsToWrite.map((record) => rowFor(record, storageHeaders));
    const added = await appendRows(sheet.spreadsheetId, sheet.sheetName, rows);
    if (needsInternalContact) {
      const helperIndex = storageHeaders.findIndex((header) => headerKey(header) === 'contactLinkedin');
      if (helperIndex >= 0) {
        try { await hideInternalContactColumn(sheet.spreadsheetId, sheet.sheetId, helperIndex); } catch {}
      }
    }

    mission.status = 'completed';
    mission.completedAt = nowIso();
    mission.sheetUrl = sheet.url;
    mission.sheetName = sheet.sheetName;
    mission.spreadsheetTitle = sheet.title;
    mission.headers = outputHeaders;
    mission.storageHeaders = storageHeaders;
    mission.destinationMode = destination ? 'existing-sheet' : 'created-sheet';
    mission.destinationHeaderRow = destination?.headerRowNumber || 1;
    mission.requested = request.count;
    mission.found = researched.records.length;
    mission.added = added;
    mission.duplicateRowsSkipped = duplicateRowsSkipped;
    mission.toolCalls = researched.toolCalls;
    mission.averageScore = researched.records.length
      ? Math.round(researched.records.reduce((sum, record) => sum + Number(record.relevanceScore || 0), 0) / researched.records.length)
      : 0;
    mission.contactsFromLinkedIn = request.entityMode === 'company' ? { emails: 0, phones: 0 } : {
      emails: recordsToWrite.filter((record) => record.email).length,
      phones: recordsToWrite.filter((record) => record.phone).length,
    };
    mission.contactTargets = request.entityMode === 'company'
      ? recordsToWrite.map((record, index) => ({
        rowNumber: firstAppendedRow + index,
        company: record.company,
        companyLinkedin: record.linkedin,
        website: record.website || '',
        domain: websiteDomain(record.website),
      }))
      : [];
    mission.contactCandidates = request.entityMode === 'company'
      ? mission.contactTargets.length
      : recordsToWrite.filter((record) => record.linkedin).length;
    mission.missingContacts = recordsToWrite.filter((record) => !record.email || !record.phone).length;
    mission.internalContactColumnHidden = needsInternalContact;
    mission.budgetStopped = researched.budgetStopped || null;
    mission.filters = researched.filters || request.filters || {};
    mission.filterVerification = researched.filterVerification || null;
    mission.linkedinSearchWarning = researched.linkedinSearchWarning || null;
    mission.linkedinSearchWarnings = Array.isArray(researched.linkedinSearchWarnings) ? researched.linkedinSearchWarnings : [];
    mission.rejectedRecords = Array.isArray(researched.rejectedRecords) ? researched.rejectedRecords : [];
    mission.safety = policy.status();

    const latest = loadState();
    const target = latest.missions.find((item) => item.id === mission.id);
    if (target) Object.assign(target, mission);
    latest.pending = null;
    saveState(latest);
    v2.rememberTemplate(outputHeaders, { sourceTitle: sheet.title, sourceUrl: sheet.url, provider: 'linkedin-account' });
    return mission;
  } catch (error) {
    mission.status = 'failed';
    mission.lastError = error.message;
    mission.updatedAt = nowIso();
    const latest = loadState();
    const target = latest.missions.find((item) => item.id === mission.id);
    if (target) Object.assign(target, mission);
    saveState(latest);
    throw error;
  }
}

function latestMission() {
  return [...loadState().missions].reverse()[0] || null;
}

function status() {
  return {
    readyForRouting: true,
    stateFile: STATE_FILE,
    mcp: mcp.status(),
    joeyism: joeyism.status(),
    safety: policy.status(),
    pending: Boolean(pendingRequest()),
    latestMission: latestMission(),
    linkedinOnlyResearch: true,
    externalSourceFusionDisabledForExplicitLinkedIn: true,
    companyLinkType: 'linkedin-company-profile',
    apolloDecisionMakerSelection: true,
    apolloDecisionMakerPriority: {
      hiring: ['talent/HR head or director', 'talent/recruitment/HR manager', 'recruiter/talent acquisition', 'founder/owner fallback'],
      general: ['director/founder/owner', 'manager/head recruiter', 'HR recruiter'],
    },
  };
}

function statusText() {
  const s = status();
  const safety = s.safety;
  const lock = safety.manualLock ? ` LOCKED: ${safety.manualLock.reason}` : safety.cooldownUntil ? ` Cooldown until ${safety.cooldownUntil}.` : '';
  const apolloReady = apollo.status().apiKeyReady && apollo.status().webhookReady;
  const testMode = safety.localBudgetBypass ? ' TEMP TEST MODE: local burst/hourly/daily budgets are bypassed; real LinkedIn cooldowns, checkpoints and write-action blocks remain enforced.' : '';
  return `LinkedIn Account Research: dedicated LinkedIn-only routing is ready. Primary backend: stickerdaniel/linkedin-mcp-server through loopback-only MCP; Apollo company-head selection/contact enrichment ${apolloReady ? 'ready' : 'needs API key + webhook setup'}. Optional joeyism fallback ${s.joeyism.enabled ? (s.joeyism.sessionReady ? 'enabled and session-ready' : 'enabled but needs manual session setup') : 'disabled'}. Usage: ${safety.hourlyUsed}/${safety.hourlyMax} this hour, ${safety.dailyUsed}/${safety.dailyMax} today. Minimum call gap ${Math.round(safety.minGapMs / 1000)}s, deep-profile cap ${safety.deepProfilesPerMission}/mission. LinkedIn write actions are disabled.${testMode}${lock}`;
}

function formatMission(mission) {
  const shortfall = mission.found < mission.requested ? ` I found ${mission.found}/${mission.requested} high-confidence LinkedIn records within the account-safety budget.` : '';
  const contact = mission.request?.entityMode === 'company'
    ? ` ${mission.contactCandidates || 0} verified company rows are ready for Apollo to select one highest-priority head and enrich that person’s contact details.`
    : ` ${mission.contactCandidates || 0} LinkedIn person profiles are ready for direct Apollo matching.`;
  const budget = mission.budgetStopped ? ` Safety stop: ${mission.budgetStopped}.` : '';
  const rejected = mission.filterVerification?.rejected || {};
  const rejectedCandidates = Number(mission.filterVerification?.rejectedCandidates || 0);
  const reasonText = Object.entries(rejected)
    .filter(([, value]) => Number(value || 0) > 0)
    .map(([key, value]) => `${key.replace(/_/g, ' ')}:${value}`)
    .join(', ');
  const hardGate = mission.filterVerification?.hardGate
    ? ` Hard-filter gate rejected ${rejectedCandidates} candidate${rejectedCandidates === 1 ? '' : 's'}${reasonText ? ` (${reasonText})` : ''}.`
    : '';
  const jobTrace = mission.request?.entityMode === 'company' && mission.request?.hiring
    ? ` Target-driven verification: topic “${mission.toolCalls?.parsedTopic || mission.request?.topic || ''}”, ${mission.toolCalls?.searchJobs || 0} searches, ${mission.toolCalls?.jobIdsDiscovered || 0} unique LinkedIn job IDs, ${mission.toolCalls?.jobDetails || 0} prioritized job details checked, ${mission.toolCalls?.jobCandidatesLinked || 0} linked to companies, ${mission.toolCalls?.jobCandidatesPassed || 0} passed job-level SAP/location/remote checks, ${mission.toolCalls?.deepCompanyProfiles || 0} company profiles checked, ${mission.toolCalls?.verifiedDuringRun || 0} verified companies reached during the run.`
    : '';
  const warnings = Array.isArray(mission.linkedinSearchWarnings) ? mission.linkedinSearchWarnings : [];
  const searchWarning = warnings.length
    ? ` LinkedIn reported ${warnings.length} search warning${warnings.length === 1 ? '' : 's'}; results were still re-verified individually.`
    : mission.linkedinSearchWarning?.error_message
      ? ` LinkedIn search warning: ${mission.linkedinSearchWarning.error_message}`
      : '';
  const destination = mission.destinationMode === 'existing-sheet'
    ? ` Filled your existing Sheet and added ${mission.added} new row${mission.added === 1 ? '' : 's'}${mission.duplicateRowsSkipped ? `; skipped ${mission.duplicateRowsSkipped} duplicate${mission.duplicateRowsSkipped === 1 ? '' : 's'} already present` : ''}.`
    : '';
  return `LinkedIn-only mission complete, Sir. Added ${mission.added} records to “${mission.spreadsheetTitle}”.${destination} Discovery and filter verification used only the authenticated LinkedIn account tool; Google Jobs, Maps, TinyFish, public-index SerpApi and Apollo were not used for discovery. Average quality score ${mission.averageScore}/100.${jobTrace}${hardGate}${contact}${shortfall}${budget}${searchWarning} ${mission.sheetUrl}`;
}

module.exports = {
  COMPANY_HEADERS,
  PERSON_HEADERS,
  INTERNAL_CONTACT_HEADER,
  isRequest,
  parseCount,
  parseRequest,
  parseEmployeeRange,
  parseFilters,
  requestTopic,
  locationScopeFromText,
  headerKey,
  ensureHeaders,
  pendingRequest,
  prepare,
  resolvePending,
  flattenText,
  collectReferences,
  linkedInReferences,
  jobIdsFromResult,
  qualityScore,
  applicantCountFromText,
  employeeCountFromText,
  passesEmployeeFilter,
  scopedCompanyEvidence,
  detectWorkType,
  locationLabelMatchesRequested,
  locationEvidenceDetails,
  locationEvidenceMatches,
  workTypeEvidenceDetails,
  workTypeEvidenceMatches,
  topicEvidenceMatches,
  companyFilterFailures,
  passesCompanyHardFilters,
  rejectedRecordSnapshot,
  dedupeRecords,
  sapRoleKeywordVariants,
  jobSearchPlan,
  droppedSearchFilters,
  searchFilterTrust,
  jobReferenceMap,
  jobIdPriority,
  prioritizedJobIds,
  jobLevelFailures,
  jobTitleFromDetail,
  companyMission,
  personMission,
  exactMission,
  contactRemark,
  rowFor,
  destinationHeaderCandidate,
  destinationExistingKeys,
  recordDestinationKeys,
  websiteDomain,
  rejectedSheetHeaders,
  rejectedSheetRow,
  latestRejectedMission,
  isRejectedSheetRequest,
  createRejectedCandidatesSheet,
  prepareApolloCompanyContacts,
  run,
  latestMission,
  status,
  statusText,
  formatMission,
};
