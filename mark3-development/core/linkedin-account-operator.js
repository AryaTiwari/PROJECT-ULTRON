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
const missionRunner = require('./linkedin-mission-runner');
const finalMaster = require('./linkedin-final-master');

const API = 'https://sheets.googleapis.com/v4/spreadsheets';
const STATE_FILE = path.join(config.projectRoot, '.ultron', 'linkedin-account', 'operator-state.json');
const PENDING_TTL_MS = 45 * 60 * 1000;

const COMPANY_HEADERS = ['NAME', 'COMPANY NAME', 'COMPANY LINK', 'NO. OF APPLICANTS', 'PHONE NUMBER', 'EMAIL', 'REMARKS'];
const PERSON_HEADERS = ['Name', 'Company', 'Role', 'LinkedIn', 'Location', 'Post Details', 'Email', 'Phone No', 'Source', 'Lead Score'];
const INTERNAL_CONTACT_HEADER = '__ULTRON CONTACT LINKEDIN';

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: 2,
    pending: null,
    missions: [],
    workspace: {
      sheetUrl: null,
      sheetName: null,
      spreadsheetTitle: null,
      entityMode: null,
      updatedAt: null,
    },
  };
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return defaultState();
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const base = defaultState();
    return {
      ...base,
      ...parsed,
      missions: Array.isArray(parsed.missions) ? parsed.missions : [],
      workspace: { ...base.workspace, ...(parsed.workspace || {}) },
    };
  } catch {
    return defaultState();
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  try { fs.chmodSync(STATE_FILE, 0o600); } catch {}
}

function latestCompletedMission(state = loadState()) {
  return [...(state.missions || [])].reverse().find((mission) => mission?.status === 'completed') || null;
}

function workspaceSheetUrl(state = loadState()) {
  const direct = String(state?.workspace?.sheetUrl || '').trim();
  if (direct) return direct;
  return String(latestCompletedMission(state)?.sheetUrl || '').trim() || null;
}

function rememberWorkspaceSheet(sheetUrl, metadata = {}, state = null) {
  const target = state || loadState();
  if (!sheetUrl) return target.workspace || null;
  target.workspace = {
    sheetUrl: String(sheetUrl),
    sheetName: metadata.sheetName || target.workspace?.sheetName || null,
    spreadsheetTitle: metadata.spreadsheetTitle || target.workspace?.spreadsheetTitle || null,
    entityMode: metadata.entityMode || target.workspace?.entityMode || null,
    updatedAt: nowIso(),
  };
  if (!state) saveState(target);
  return target.workspace;
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

function parseExplicitCount(text) {
  const value = String(text || '');
  const match = value.match(/\b(?:find|get|bring|research|source|collect|search|list|show|extract|continue|add|append)\s+(?:me\s+)?(\d{1,3})\b/i)
    || value.match(/\b(\d{1,3})\s+(?:more\s+)?(?:companies|company|people|profiles?|professionals?|recruiters?|founders?|leads?|results?)\b/i)
    || value.match(/\b(?:until|to)\s+(\d{1,3})\b/i);
  return match ? Math.max(1, Math.min(100, Number(match[1]))) : null;
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


function hiringIntentFromText(text, filters = {}) {
  const value = String(text || '').trim();
  if (!value) return false;

  if (/\b(?:hiring|recruiting|jobs?|vacanc(?:y|ies)|openings?|roles?|positions?|careers?)\b/i.test(value)) return true;

  // Explicit company-attribute language should stay a company search even
  // when words such as "remote" appear.
  const explicitCompanyAttribute = /\b(?:companies?|employers?)\b[\s\S]{0,55}\b(?:based|headquartered|hq|located|remote[- ]?first|distributed|fully\s+remote\s+company|uses?|using|implements?|runs?|partners?\s+with)\b/i.test(value)
    || /\b(?:remote[- ]?first|distributed|fully\s+remote)\b[\s\S]{0,55}\b(?:companies?|employers?|firms?|organizations?|organisations?)\b/i.test(value)
    || /\b(?:headquarters?|hq|company\s+location|company\s+headcount)\b/i.test(value);
  if (explicitCompanyAttribute) return false;

  const companyTarget = /\b(?:companies?|company|employers?|firms?|organizations?|organisations?)\b/i.test(value);
  if (!companyTarget) return false;

  // These are job-level filters in LinkedIn. If a user applies them to
  // companies plus a non-empty skill/topic, they almost certainly mean
  // companies with matching openings, even if they omit "jobs".
  const jobLevelConstraint = Boolean(
    filters.workType
    || filters.jobType
    || filters.experienceLevel
    || filters.datePosted
    || filters.easyApply
  );
  if (!jobLevelConstraint) return false;

  const stripped = value
    .replace(/\b(?:find|get|bring|research|source|collect|search|list|show|extract)\b/gi, ' ')
    .replace(/\b\d{1,3}\b/g, ' ')
    .replace(/\b(?:companies?|company|employers?|firms?|organizations?|organisations?|linkedin|remote|hybrid|on[- ]?site|in[- ]?office|full[- ]?time|part[- ]?time|contract|internship|entry[- ]?level|associate|mid[- ]?senior|executive|easy\s+apply|under|below|over|above|employees?|employee|in|from|at|near|around|and|the|my|master|sheet|spreadsheet)\b/gi, ' ')
    .replace(/\d[\d,]*/g, ' ')
    .replace(/[.,;:!?()[\]{}]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return stripped.length >= 2;
}

function locationScopeFromText(text, hiring = false) {
  const value = String(text || '');
  if (/\bcompanies?\b[\s\S]{0,45}\b(?:that\s+are\s+)?(?:based|headquartered|located)\b/i.test(value)
      || /\b(?:company|employer)\s+(?:headquarters?|hq)\b/i.test(value)) {
    return 'company';
  }
  return hiring ? 'job' : 'company';
}

function parseRequest(text) {
  const value = String(text || '').trim();
  if (!isRequest(value)) return null;
  const explicitSheetUrl = sheets.extractSheetUrl(value);
  const wantsWorkspaceSheet = /\b(?:current|same|existing|last|latest|master|consolidated)\s+(?:google\s+)?(?:sheet|spreadsheet)\b/i.test(value);
  const wantsFinalMaster = /\b(?:master|final\s+master|final\s+(?:lead\s+)?database)\b/i.test(value);
  const destinationSheetUrl = explicitSheetUrl || (wantsFinalMaster
    ? (finalMaster.masterSheetUrl() || workspaceSheetUrl())
    : (wantsWorkspaceSheet ? workspaceSheetUrl() : null));
  const criteriaText = String(explicitSheetUrl ? value.replace(explicitSheetUrl, ' ') : value)
    .replace(/\b(?:and\s+)?(?:put|write|add|fill|save|append|send|keep)\s+(?:(?:them|it|these|those)\s+)?(?:the\s+)?(?:results?|companies|leads?|rows?)?\s*(?:into|in|to)?\s*(?:my|this|the)?\s*(?:current|same|existing|last|latest|master|consolidated)?\s*(?:google\s+)?(?:sheet|spreadsheet)\b/gi, ' ')
    .replace(/\b(?:in|into|to|on)\s+(?:the\s+)?(?:current|same|existing|last|latest|master|consolidated)\s+(?:google\s+)?(?:sheet|spreadsheet)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const entity = linkedinPublic.normalizeLinkedInEntityUrl(criteriaText);
  const location = linkedinPublic.locationFromText(criteriaText);
  const filters = parseFilters(criteriaText);
  const hiring = hiringIntentFromText(criteriaText, filters);

  // Employee-count constraints describe company size, not a request for
  // LinkedIn people. Strip those phrases before inferring person intent.
  const peopleIntentText = criteriaText
    .replace(/\b(?:under|below|fewer\s+than|less\s+than|up\s+to|maximum|max|over|above|more\s+than|at\s+least|minimum|min)\s*\d[\d,]*\s+employees?\b/gi, ' ')
    .replace(/\b\d[\d,]*\s*(?:-|to)\s*\d[\d,]*\s+employees?\b/gi, ' ')
    .replace(/\b(?:employee\s+count|company\s+size|headcount)\b/gi, ' ');
  const explicitlyPeople = /\b(?:people|persons?|professionals?|recruiters?|founders?|employees?|candidates?|profiles?)\b/i.test(peopleIntentText);
  const inferredMode = linkedinPublic.entityModeFromText(criteriaText);
  const entityMode = entity?.type || (hiring && !explicitlyPeople ? 'company' : inferredMode);
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
    filters,
    destinationSheetUrl,
    useFinalMaster: wantsFinalMaster,
    allowPreviouslySeenCompanies: finalMaster.allowRepeatFromText(value),
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
    gridColumnCount: Number(tabs.find((tab) => tab?.properties?.sheetId === chosen.sheetId)?.properties?.gridProperties?.columnCount || 0),
    gridRowCount: Number(tabs.find((tab) => tab?.properties?.sheetId === chosen.sheetId)?.properties?.gridProperties?.rowCount || 0),
    headerRowNumber: chosen.rowNumber,
    originalHeaders: chosen.headers,
    headers,
    rows: fullRows,
    lastNonEmptyRow,
    url,
  };
}

async function syncDestinationHeaders(destination, headers) {
  await sheets.ensureGridSize(destination.spreadsheetId, destination.sheetId, {
    minColumns: Math.max(1, headers.length),
    minRows: Math.max(2, destination.lastNonEmptyRow + 2),
  });
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
    try {
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
    } catch (error) {
      if (!isGoogleSheetsError(error)) throw error;
      const fallbackHeaders = ensureHeaders(
        request.entityMode === 'company' ? COMPANY_HEADERS : PERSON_HEADERS,
        request,
      );
      return {
        type: 'run',
        request: {
          ...request,
          destinationPreflightError: sheetErrorSnapshot(error),
        },
        headers: fallbackHeaders,
      };
    }
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
  if (range) {
    return {
      min: compactNumber(range[1]),
      max: compactNumber(range[2]),
      label: `${range[1]}-${range[2]}`,
      openEnded: false,
    };
  }

  const plus = source.match(/\b(?:company size\s*[:·-]?\s*)?(\d[\d,]*)\+\s*employees?\b/i);
  if (plus) {
    const count = compactNumber(plus[1]);
    return count == null ? null : { min: count, max: null, label: `${plus[1]}+`, openEnded: true };
  }

  const exact = source.match(/\b(?:company size|employees?)\s*[:·-]?\s*(\d[\d,]*)\b/i)
    || source.match(/\b(\d[\d,]*)\s+employees?\b/i);
  if (!exact) return null;
  const count = compactNumber(exact[1]);
  return count == null ? null : { min: count, max: count, label: exact[1], openEnded: false };
}

function passesEmployeeFilter(record, filters = {}) {
  if (filters.employeeMin == null && filters.employeeMax == null) return true;
  const size = record.employeeCount;
  if (!size || !Number.isFinite(Number(size.min))) return false;

  // Hard filters use the whole LinkedIn company-size interval. A company in
  // "1,000-5,000" cannot be claimed as under 1,000 merely because the lower
  // bound touches the requested ceiling.
  if (filters.employeeMin != null && Number(size.min) < filters.employeeMin) return false;
  if (filters.employeeMax != null && (size.openEnded || !Number.isFinite(Number(size.max)) || Number(size.max) > filters.employeeMax)) return false;
  return true;
}

const LOCATION_REGION_ALIASES = {
  india: [
    'india', 'bengaluru', 'bangalore', 'hyderabad', 'pune', 'mumbai', 'navi mumbai',
    'chennai', 'delhi', 'new delhi', 'gurugram', 'gurgaon', 'noida', 'kolkata',
    'ahmedabad', 'vadodara', 'surat', 'kochi', 'cochin', 'thiruvananthapuram',
    'jaipur', 'indore', 'bhopal', 'bhubaneswar', 'chandigarh', 'mohali',
    'visakhapatnam', 'vijayawada', 'lucknow', 'nagpur', 'nashik', 'coimbatore',
  ],
  maharashtra: [
    'maharashtra', 'mumbai', 'navi mumbai', 'thane', 'pune', 'nagpur', 'nashik',
    'aurangabad', 'chhatrapati sambhajinagar', 'kolhapur', 'solapur', 'amravati',
    'satara', 'sangli', 'jalgaon', 'akola', 'latur', 'ratnagiri',
  ],
  karnataka: ['karnataka', 'bengaluru', 'bangalore', 'mysuru', 'mysore', 'mangaluru', 'mangalore', 'hubballi', 'dharwad'],
  telangana: ['telangana', 'hyderabad', 'secunderabad', 'warangal'],
  'tamil nadu': ['tamil nadu', 'chennai', 'coimbatore', 'madurai', 'tiruchirappalli', 'trichy', 'hosur'],
  'west bengal': ['west bengal', 'kolkata', 'calcutta', 'howrah', 'durgapur', 'siliguri'],
  gujarat: ['gujarat', 'ahmedabad', 'gandhinagar', 'vadodara', 'baroda', 'surat', 'rajkot'],
  haryana: ['haryana', 'gurugram', 'gurgaon', 'faridabad', 'panipat'],
  'uttar pradesh': ['uttar pradesh', 'noida', 'greater noida', 'ghaziabad', 'lucknow', 'kanpur', 'prayagraj', 'agra'],
  rajasthan: ['rajasthan', 'jaipur', 'jodhpur', 'udaipur', 'kota'],
  kerala: ['kerala', 'kochi', 'cochin', 'thiruvananthapuram', 'trivandrum', 'kozhikode', 'calicut'],
  'madhya pradesh': ['madhya pradesh', 'indore', 'bhopal', 'jabalpur', 'gwalior'],
  odisha: ['odisha', 'orissa', 'bhubaneswar', 'cuttack', 'rourkela'],
  punjab: ['punjab', 'mohali', 'sahibzada ajit singh nagar', 'ludhiana', 'amritsar', 'jalandhar', 'chandigarh'],
  'andhra pradesh': ['andhra pradesh', 'visakhapatnam', 'vizag', 'vijayawada', 'tirupati', 'guntur'],
  bihar: ['bihar', 'patna'],
  jharkhand: ['jharkhand', 'ranchi', 'jamshedpur'],
  chhattisgarh: ['chhattisgarh', 'raipur', 'bilaspur'],
  assam: ['assam', 'guwahati'],
  'arunachal pradesh': ['arunachal pradesh', 'itanagar'],
  manipur: ['manipur', 'imphal'],
  meghalaya: ['meghalaya', 'shillong'],
  mizoram: ['mizoram', 'aizawl'],
  nagaland: ['nagaland', 'kohima', 'dimapur'],
  sikkim: ['sikkim', 'gangtok'],
  tripura: ['tripura', 'agartala'],
  uttarakhand: ['uttarakhand', 'dehradun', 'haridwar'],
  goa: ['goa', 'panaji', 'margao'],
  'himachal pradesh': ['himachal pradesh', 'shimla'],
  'jammu and kashmir': ['jammu and kashmir', 'jammu', 'srinagar'],
  'jammu & kashmir': ['jammu & kashmir', 'jammu and kashmir', 'jammu', 'srinagar'],
  ladakh: ['ladakh', 'leh', 'kargil'],
  chandigarh: ['chandigarh'],
  puducherry: ['puducherry', 'pondicherry'],
  'andaman and nicobar islands': ['andaman and nicobar islands', 'port blair'],
  lakshadweep: ['lakshadweep', 'kavaratti'],
  'dadra and nagar haveli and daman and diu': ['dadra and nagar haveli and daman and diu', 'silvassa', 'daman', 'diu'],
  delhi: ['delhi', 'new delhi', 'delhi ncr', 'ncr'],
  'delhi ncr': ['delhi ncr', 'delhi', 'new delhi', 'gurugram', 'gurgaon', 'noida', 'greater noida', 'faridabad', 'ghaziabad'],
};

const LOCATION_SEARCH_HUBS = {
  india: ['India', 'Bengaluru', 'Hyderabad', 'Pune', 'Mumbai', 'Chennai', 'Delhi NCR', 'Gurugram', 'Noida', 'Kolkata', 'Ahmedabad'],
  maharashtra: ['Maharashtra', 'Pune', 'Mumbai', 'Navi Mumbai', 'Thane', 'Nagpur', 'Nashik'],
  karnataka: ['Karnataka', 'Bengaluru', 'Mysuru', 'Mangaluru', 'Hubballi'],
  telangana: ['Telangana', 'Hyderabad', 'Secunderabad'],
  'tamil nadu': ['Tamil Nadu', 'Chennai', 'Coimbatore', 'Hosur', 'Madurai'],
  'west bengal': ['West Bengal', 'Kolkata', 'Howrah', 'Durgapur'],
  gujarat: ['Gujarat', 'Ahmedabad', 'Gandhinagar', 'Vadodara', 'Surat'],
  haryana: ['Haryana', 'Gurugram', 'Faridabad'],
  'uttar pradesh': ['Uttar Pradesh', 'Noida', 'Greater Noida', 'Ghaziabad', 'Lucknow'],
  rajasthan: ['Rajasthan', 'Jaipur', 'Jodhpur', 'Udaipur'],
  kerala: ['Kerala', 'Kochi', 'Thiruvananthapuram', 'Kozhikode'],
  'madhya pradesh': ['Madhya Pradesh', 'Indore', 'Bhopal'],
  odisha: ['Odisha', 'Bhubaneswar', 'Cuttack'],
  punjab: ['Punjab', 'Mohali', 'Ludhiana', 'Amritsar', 'Chandigarh'],
  'andhra pradesh': ['Andhra Pradesh', 'Visakhapatnam', 'Vijayawada', 'Tirupati'],
  bihar: ['Bihar', 'Patna'],
  jharkhand: ['Jharkhand', 'Ranchi', 'Jamshedpur'],
  chhattisgarh: ['Chhattisgarh', 'Raipur'],
  assam: ['Assam', 'Guwahati'],
  'arunachal pradesh': ['Arunachal Pradesh', 'Itanagar'],
  manipur: ['Manipur', 'Imphal'],
  meghalaya: ['Meghalaya', 'Shillong'],
  mizoram: ['Mizoram', 'Aizawl'],
  nagaland: ['Nagaland', 'Dimapur', 'Kohima'],
  sikkim: ['Sikkim', 'Gangtok'],
  tripura: ['Tripura', 'Agartala'],
  uttarakhand: ['Uttarakhand', 'Dehradun'],
  goa: ['Goa', 'Panaji'],
  'himachal pradesh': ['Himachal Pradesh', 'Shimla'],
  'jammu and kashmir': ['Jammu and Kashmir', 'Jammu', 'Srinagar'],
  'jammu & kashmir': ['Jammu and Kashmir', 'Jammu', 'Srinagar'],
  ladakh: ['Ladakh', 'Leh'],
  chandigarh: ['Chandigarh'],
  puducherry: ['Puducherry'],
  'andaman and nicobar islands': ['Andaman and Nicobar Islands', 'Port Blair'],
  lakshadweep: ['Lakshadweep'],
  'dadra and nagar haveli and daman and diu': ['Dadra and Nagar Haveli and Daman and Diu', 'Silvassa', 'Daman'],
  delhi: ['Delhi', 'New Delhi', 'Delhi NCR'],
  'delhi ncr': ['Delhi NCR', 'Delhi', 'New Delhi', 'Gurugram', 'Noida', 'Faridabad', 'Ghaziabad'],
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
    { value: 'remote', regex: /(?:^|\n)\s*remote(?:\s*\([^\n)]+\))?\s*(?:$|\n)/im },
    { value: 'hybrid', regex: /(?:^|\n)\s*hybrid(?:\s*\([^\n)]+\))?\s*(?:$|\n)/im },
    { value: 'on_site', regex: /(?:^|\n)\s*on[- ]?site(?:\s*\([^\n)]+\))?\s*(?:$|\n)/im },
    { value: 'remote', regex: /(?:^|[·|,])\s*remote\s*(?=$|[·|,\n])/im },
    { value: 'hybrid', regex: /(?:^|[·|,])\s*hybrid\s*(?=$|[·|,\n])/im },
    { value: 'on_site', regex: /(?:^|[·|,])\s*on[- ]?site\s*(?=$|[·|,\n])/im },
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

    // If LinkedIn's actual job page names a recognised location outside the
    // requested region, do not let a retained search facet overrule it.
    const observedJobLocation = linkedinPublic.locationFromText(explicit);
    if (observedJobLocation && !locationLabelMatchesRequested(observedJobLocation, requested)) {
      return { matched: false, source: 'job_conflict', label: observedJobLocation };
    }

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
      if (/\b(?:ABAP|FICO|S\/?4HANA|HANA|SuccessFactors|Ariba|BTP|CPI|EWM|TM|BW|BPC)\b/i.test(titleEvidence)) return true;
      const keywords = Array.isArray(record?.searchProvenance?.keywords) ? record.searchProvenance.keywords : [];
      const queryBackedModules = ['Basis', 'MM', 'SD', 'EWM', 'TM', 'BW', 'BPC', 'BTP', 'CPI', 'Security'];
      for (const module of queryBackedModules) {
        const queryRegex = new RegExp('^SAP\\s+' + evidenceRegexEscape(module) + '$', 'i');
        if (containsEvidenceTerm(titleEvidence, module)
            && keywords.some((value) => queryRegex.test(String(value)))) return true;
      }
      return false;
    }

    const knownModule = rest.match(/^(fico|mm|sd|abap|basis|s\/?4hana|successfactors|hana|bw|bpc|ariba|ewm|tm|btp|cpi|security)\b/i);
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
    role: String(record?.role || '').trim(),
    jobId: String(record?.jobId || '').trim(),
    jobUrl: String(record?.jobUrl || '').trim(),
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
    const result = await missionRunner.call(tool, args, () => mcp.callTool(tool, args));
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
    'SAP Developer',
    'SAP Functional Consultant',
    'SAP Technical Consultant',
    'SAP FICO',
    'SAP ABAP',
    'SAP MM',
    'SAP SD',
    'SAP Basis',
    'SAP S/4HANA',
    'SAP SuccessFactors',
    'SAP BTP',
    'SAP CPI',
    'SAP EWM',
    'SAP TM',
    'SAP BW',
    'SAP HANA',
    'SAP Ariba',
    'SAP Security',
  ];
}

function jobSearchPlan(request) {
  const keywords = sapRoleKeywordVariants(searchKeyword(request));
  const location = String(request.location || '').trim();
  const normalizedLocation = location.toLowerCase();
  const hubs = LOCATION_SEARCH_HUBS[normalizedLocation] || (location ? [location] : ['']);
  const plan = [];
  const add = (keyword, loc) => {
    const key = (String(keyword || '').trim().toLowerCase() + '|' + String(loc || '').trim().toLowerCase());
    if (!keyword || plan.some((item) => item.key === key)) return;
    plan.push({ key, keyword: String(keyword).trim(), location: String(loc || '').trim() || null });
  };

  // Geographic breadth comes first. A state/country request should not be
  // reduced to one literal LinkedIn query when hiring is concentrated in hubs.
  for (const place of hubs) add(keywords[0], place || null);

  // Then spend remaining search diversity on role/module variants at the
  // broad requested geography. This keeps the planner generic while making
  // SAP-style title fragmentation much less likely to hide valid companies.
  const broadLocation = location || null;
  for (const keyword of keywords.slice(1)) add(keyword, broadLocation);

  return plan.slice(0, 20).map(({ key, ...item }) => item);
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
  const trustedLocations = Array.isArray(meta.trustedLocations) ? meta.trustedLocations : [];
  const trustedWorkTypes = Array.isArray(meta.trustedWorkTypes) ? meta.trustedWorkTypes : [];
  if (/\bSAP\b/i.test(title)) score += 60;
  if (/\b(?:FICO|ABAP|S\/4HANA|S4HANA|SuccessFactors|Basis)\b/i.test(title)) score += 18;
  if (/\bSAP\b/i.test(keyword)) score += 8;
  if (/\b(?:FICO|ABAP|MM|SD|Basis|S\/4HANA|SuccessFactors)\b/i.test(keyword)) score += 10;
  if (trustedLocations.some((value) => /^(?:Pune|Mumbai|Navi Mumbai|Nagpur|Thane|Nashik|Maharashtra)$/i.test(String(value)))) score += 16;
  if (trustedWorkTypes.some((value) => /^remote$/i.test(String(value)))) score += 12;
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

function joeyismJobToDetail(job, jobId = '') {
  if (!job || typeof job !== 'object') return null;
  const companyUrl = String(job.company_linkedin_url || '').trim();
  const lines = [
    job.job_title,
    job.company,
    job.location,
    job.posted_date,
    job.applicant_count,
    job.job_description,
  ].map((value) => String(value || '').trim()).filter(Boolean);
  if (!lines.length) return null;
  const result = {
    url: String(job.linkedin_url || (jobId ? `https://www.linkedin.com/jobs/view/${jobId}` : '')).trim(),
    sections: { job_posting: lines.join('\n') },
    references: {},
    structuredFallback: true,
  };
  if (companyUrl) {
    result.references.job_posting = [{
      kind: 'company',
      url: companyUrl,
      text: String(job.company || '').trim(),
      context: 'job posting',
    }];
  }
  return result;
}

function joeyismCompanyText(company) {
  if (!company || typeof company !== 'object') return '';
  return [
    company.name,
    company.about_us,
    company.company_size ? `Company size: ${company.company_size}` : '',
    company.headquarters ? `Headquarters: ${company.headquarters}` : '',
    company.industry ? `Industry: ${company.industry}` : '',
    company.website ? `Website: ${company.website}` : '',
    company.phone ? `Phone: ${company.phone}` : '',
  ].filter(Boolean).join('\n');
}

function shouldPropagateFallbackError(error) {
  const code = String(error?.code || '');
  const kind = String(error?.linkedinSafety?.kind || '');
  return /LINKEDIN_(?:COOLDOWN_ACTIVE|MANUAL_LOCK|BURST_CAP|HOURLY_CAP|DAILY_CAP)/.test(code)
    || /^(?:rate-limit|manual-lock)$/.test(kind);
}

async function optionalStructuredJobFallback(budget, jobId) {
  if (!joeyism.enabled() || budget.used >= budget.maximum) return null;
  try {
    const job = await joeyism.call('job', {
      job_id: String(jobId),
      url: `https://www.linkedin.com/jobs/view/${jobId}`,
    });
    budget.used++;
    return joeyismJobToDetail(job, jobId);
  } catch (error) {
    if (shouldPropagateFallbackError(error)) throw error;
    return null;
  }
}

async function optionalStructuredCompanyFallback(budget, linkedinUrl) {
  if (!joeyism.enabled() || budget.used >= budget.maximum || !linkedinUrl) return null;
  try {
    const company = await joeyism.call('company', { url: linkedinUrl });
    budget.used++;
    return company;
  } catch (error) {
    if (shouldPropagateFallbackError(error)) throw error;
    return null;
  }
}

async function callPrimaryWithExactFallback(tool, args, fallback = null) {
  try {
    return await missionRunner.call(tool, args, () => mcp.callTool(tool, args));
  } catch (error) {
    const eligible = fallback && joeyism.enabled()
      && /LINKEDIN_MCP_|auth|session|browser|profile/i.test(`${error.code || ''} ${error.message || ''}`);
    if (!eligible) throw error;
    return joeyism.call(fallback.action, fallback.args);
  }
}

function criteriaSignature(request = {}) {
  const filters = request.filters || {};
  return JSON.stringify({
    entityMode: request.entityMode || '',
    topic: String(request.topic || '').trim().toLowerCase(),
    location: String(request.location || '').trim().toLowerCase(),
    locationScope: request.locationScope || '',
    hiring: Boolean(request.hiring),
    employeeMin: filters.employeeMin ?? null,
    employeeMax: filters.employeeMax ?? null,
    workType: filters.workType || null,
    jobType: filters.jobType || null,
    experienceLevel: filters.experienceLevel || null,
    datePosted: filters.datePosted || null,
    easyApply: Boolean(filters.easyApply),
  });
}

function previousCheckedJobIds(request = {}) {
  const signature = criteriaSignature(request);
  const ids = new Set();
  for (const mission of loadState().missions || []) {
    if (mission?.status !== 'completed') continue;
    if (criteriaSignature(mission.request || {}) !== signature) continue;
    for (const id of mission?.toolCalls?.checkedJobIds || []) {
      const value = String(id || '').trim();
      if (value) ids.add(value);
    }
  }
  return ids;
}

function reconsiderRejectedCandidates(request = {}) {
  if (!request.continueFromPrevious) return [];
  const topic = String(request.topic || '').trim().toLowerCase();
  const state = loadState();
  const byKey = new Map();
  for (const mission of state.missions || []) {
    if (mission?.status !== 'completed' || mission?.request?.entityMode !== 'company') continue;
    if (String(mission.request?.topic || '').trim().toLowerCase() !== topic) continue;
    for (const rejected of mission.rejectedRecords || []) {
      if (!rejected?.jobUrl || !rejected?.linkedin) continue;
      const record = {
        entityType: 'company',
        company: rejected.company || '',
        linkedin: rejected.linkedin || '',
        role: rejected.role || '',
        jobId: rejected.jobId || '',
        jobUrl: rejected.jobUrl || '',
        location: rejected.location || '',
        locationEvidenceSource: rejected.locationEvidenceSource || '',
        workType: rejected.workType || '',
        workTypeEvidenceSource: rejected.workTypeEvidenceSource || '',
        employeeCount: rejected.employeeCount || null,
        applicants: rejected.applicants || '',
        relevanceScore: Number(rejected.relevanceScore || 0),
        hiringSignal: rejected.hiringSignal || '',
        jobEvidenceText: rejected.jobEvidenceText || '',
        companyEvidenceText: rejected.companyEvidenceText || '',
        sourceEvidence: [...new Set([...(rejected.sourceEvidence || []), 'cross-mission-reconsidered'])],
      };
      if (!request.allowPreviouslySeenCompanies && finalMaster.seen(record)) continue;
      if (companyFilterFailures(record, request).length) continue;
      const key = finalMaster.companyKey(record);
      if (!key) continue;
      const previous = byKey.get(key);
      if (!previous || record.relevanceScore > previous.relevanceScore) byKey.set(key, record);
    }
  }
  return [...byKey.values()];
}

async function companyMission(request) {
  const reconsidered = reconsiderRejectedCandidates(request);
  const records = reconsidered.slice();
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
  const checkedJobIds = [];
  const previouslyChecked = request.continueFromPrevious ? previousCheckedJobIds(request) : new Set();
  const acceptedCompanies = new Set(
    reconsidered.map((record) => finalMaster.companyKey(record)).filter(Boolean)
  );
  verifiedDuringRun = acceptedCompanies.size;

  if (request.hiring) {
    const plan = jobSearchPlan(request);
    const maxSearchCalls = acceptedCompanies.size >= request.count ? 0 : (budget.localBudgetBypass
      ? Math.min(plan.length, Number(policy.settings().testJobSearchMax || 20))
      : 1);

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
    const orderedJobIds = prioritizedJobIds(jobMeta).filter((jobId) => !previouslyChecked.has(String(jobId)));

    for (const jobId of orderedJobIds) {
      if (acceptedCompanies.size >= request.count) break;
      if (budget.used >= budget.maximum) {
        budget.stopped = budget.stopped || 'mission LinkedIn-call budget reached';
        break;
      }

      let detail = await budgetedCall(budget, 'get_job_details', { job_id: jobId });
      if (!detail) break;
      jobDetails++;
      checkedJobIds.push(String(jobId));

      let detailText = flattenText(detail);
      let companyRefs = linkedInReferences(detail, 'company');
      let preferred = companyRefs.find((ref) => /job posting|job/i.test(String(ref.context || '')))
        || companyRefs.find((ref) => String(ref.kind || '').toLowerCase() === 'company')
        || companyRefs[0];
      let structuredFallbackUsed = false;

      if (!preferred && joeyism.enabled()) {
        const fallbackDetail = await optionalStructuredJobFallback(budget, jobId);
        if (fallbackDetail) {
          structuredFallbackUsed = true;
          detail = fallbackDetail;
          detailText = flattenText(detail);
          companyRefs = linkedInReferences(detail, 'company');
          preferred = companyRefs.find((ref) => /job posting|job/i.test(String(ref.context || '')))
            || companyRefs[0];
        }
      }
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

      let jobFailures = jobLevelFailures(record, request);
      if (jobFailures.length && joeyism.enabled() && !structuredFallbackUsed && budget.used < budget.maximum) {
        const fallbackDetail = await optionalStructuredJobFallback(budget, jobId);
        if (fallbackDetail) {
          structuredFallbackUsed = true;
          const fallbackText = flattenText(fallbackDetail);
          const fallbackRefs = linkedInReferences(fallbackDetail, 'company');
          const fallbackCompany = fallbackRefs.find((ref) => /job posting|job/i.test(String(ref.context || ''))) || fallbackRefs[0];
          record.jobEvidenceText = mergeEvidenceText(record.jobEvidenceText, fallbackText, 16000);
          record.hiringSignal = mergeEvidenceText(record.hiringSignal, fallbackText.slice(0, 1200), 2200);
          record.role = jobTitleFromDetail(fallbackDetail, record.role || meta.title || '');
          record.workType = detectWorkType(record.jobEvidenceText);
          record.applicants = record.applicants || applicantCountFromText(fallbackText, fallbackCompany?.text || record.company);
          record.sourceEvidence = [...new Set([...(record.sourceEvidence || []), 'joeyism-structured-job-fallback'])];

          if (fallbackCompany) {
            const fallbackRecord = referenceRecord(fallbackCompany, request);
            if (fallbackRecord?.linkedin && !record.linkedin) record.linkedin = fallbackRecord.linkedin;
            if (fallbackRecord?.company && !record.company) record.company = fallbackRecord.company;
          }
          jobFailures = jobLevelFailures(record, request);
        }
      }

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

        const needsCompanySize = request.filters?.employeeMin != null || request.filters?.employeeMax != null;
        if (needsCompanySize && !record.employeeCount && joeyism.enabled() && budget.used < budget.maximum) {
          const fallbackCompany = await optionalStructuredCompanyFallback(budget, record.linkedin);
          if (fallbackCompany) {
            const fallbackText = joeyismCompanyText(fallbackCompany);
            record.companyEvidenceText = mergeEvidenceText(record.companyEvidenceText, fallbackText, 16000);
            record.employeeCount = employeeCountFromText(String(fallbackCompany.company_size || ''))
              || employeeCountFromText(fallbackText)
              || record.employeeCount;
            record.companyLocation = record.companyLocation || String(fallbackCompany.headquarters || '').trim();
            record.website = record.website || String(fallbackCompany.website || '').trim();
            record.sourceEvidence = [...new Set([...(record.sourceEvidence || []), 'joeyism-structured-company-fallback'])];
          }
        }
      } catch (error) {
        if (error.code === 'LINKEDIN_COOLDOWN_ACTIVE' || error.code === 'LINKEDIN_MANUAL_LOCK') throw error;
        record.deepError = error.message;
      }

      profileCheckedCompanies.set(companyKey, record);
      records.push(record);

      if (companyFilterFailures(record, request).length === 0) {
        const globallySeen = !request.allowPreviouslySeenCompanies && finalMaster.seen(record);
        if (!globallySeen) {
          acceptedCompanies.add(companyKey);
          verifiedDuringRun = acceptedCompanies.size;
        } else {
          record.globalSeen = true;
        }
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

    if (!request.allowPreviouslySeenCompanies && finalMaster.seen(record)) {
      record.globalSeen = true;
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
      checkedJobIds: request.hiring ? checkedJobIds : [],
      skippedPreviouslyChecked: request.hiring && request.continueFromPrevious ? previouslyChecked.size : 0,
      globallySeenSkipped: records.filter((record) => record.globalSeen).length,
      cachedReconsidered: reconsidered.length,
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

function personSearchPlan(request) {
  const topic = searchKeyword(request);
  const criteria = String(request.criteriaText || request.originalMessage || '');
  const roleVariants = [];
  const addRole = (value) => {
    const clean = String(value || '').replace(/\s+/g, ' ').trim();
    if (clean && !roleVariants.some((item) => item.toLowerCase() === clean.toLowerCase())) roleVariants.push(clean);
  };

  if (/\b(?:recruiters?|talent\s+acquisition|hr|human\s+resources?)\b/i.test(criteria)) {
    addRole(`${topic} recruiter`);
    addRole(`${topic} talent acquisition`);
    addRole(`${topic} HR recruiter`);
    addRole(`technical recruiter ${topic}`);
  } else {
    addRole(topic);
    addRole(`${topic} professional`);
    addRole(`${topic} specialist`);
  }

  const locations = /^maharashtra$/i.test(String(request.location || ''))
    ? ['Maharashtra', 'Pune', 'Mumbai', 'Navi Mumbai', 'Thane']
    : [request.location || null];

  const plan = [];
  for (const location of locations) {
    for (const keyword of roleVariants) {
      const key = `${keyword.toLowerCase()}|${String(location || '').toLowerCase()}`;
      if (!plan.some((item) => item.key === key)) plan.push({ key, keyword, location });
      if (plan.length >= 12) break;
    }
    if (plan.length >= 12) break;
  }
  return plan.map(({ key, ...item }) => item);
}

async function personMission(request) {
  const budget = missionCallBudget();
  if (budget.maximum < 1) {
    const error = new Error('No LinkedIn account calls remain in the current safety budget.');
    error.code = 'LINKEDIN_BURST_CAP';
    throw error;
  }

  const results = [];
  const searches = [];
  const plan = personSearchPlan(request);
  const maxSearches = budget.localBudgetBypass ? Math.min(plan.length, 12) : Math.min(plan.length, 2);

  for (const step of plan.slice(0, maxSearches)) {
    const search = await budgetedCall(budget, 'search_people', {
      keywords: step.keyword,
      location: step.location || undefined,
    });
    if (!search) break;
    searches.push({ keyword: step.keyword, location: step.location || null });

    for (const ref of linkedInReferences(search, 'person')) {
      const record = referenceRecord(ref, request);
      if (!record) continue;
      record.searchProvenance = {
        keywords: [step.keyword],
        locations: step.location ? [step.location] : [],
      };
      record.relevanceScore = qualityScore(record, request);
      results.push(record);
    }

    const unique = dedupeRecords(results, 'person').length;
    if (unique >= Math.max(request.count * 2, request.count + 10)) break;
  }

  let merged = dedupeRecords(results, 'person')
    .sort((a, b) => Number(b.relevanceScore || 0) - Number(a.relevanceScore || 0));

  const remaining = Math.max(0, budget.maximum - budget.used);
  const deepMax = budget.localBudgetBypass
    ? Math.min(merged.length, request.count, remaining)
    : Math.min(policy.settings().deepProfilesPerMission, merged.length, request.count, remaining);

  let deepProfiles = 0;
  for (let index = 0; index < deepMax; index++) {
    const record = merged[index];
    const slug = linkedinPublic.normalizeLinkedInEntityUrl(record.linkedin, 'person')?.slug;
    if (!slug) continue;
    try {
      const deep = await budgetedCall(budget, 'get_person_profile', {
        linkedin_username: slug,
        sections: request.wantsContacts ? 'experience,contact_info' : 'experience',
        max_scrolls: 5,
      });
      if (!deep) break;
      deepProfiles++;
      const text = flattenText(deep);
      record.snippet = [record.snippet, text.slice(0, 5000)].filter(Boolean).join('\n').slice(0, 6500);
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
    toolCalls: {
      searchPeople: searches.length,
      searchPlan: searches,
      deepPersonProfiles: deepProfiles,
      total: budget.used,
      maximum: budget.maximum,
    },
    budgetStopped: budget.stopped,
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

function isGoogleSheetsError(error) {
  const code = String(error?.code || '');
  return /^GOOGLE_SHEETS_/.test(code) || Number(error?.status || 0) >= 400;
}

function sheetErrorSnapshot(error) {
  return {
    code: String(error?.code || 'GOOGLE_SHEETS_API_ERROR'),
    message: String(error?.message || 'Google Sheets API error'),
    status: Number(error?.status || 0) || null,
    googleStatus: error?.googleStatus || null,
    googleCode: error?.googleCode || null,
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
  if (!response.ok) {
    const error = new Error(data?.error?.message || `Google Sheets API failed (${response.status}).`);
    error.status = response.status;
    error.googleStatus = data?.error?.status || null;
    error.googleCode = data?.error?.code || response.status;
    error.googleDetails = Array.isArray(data?.error?.details) ? data.error.details : [];
    error.code = response.status === 403
      ? 'GOOGLE_SHEETS_FORBIDDEN'
      : response.status === 404
        ? 'GOOGLE_SHEETS_NOT_FOUND'
        : 'GOOGLE_SHEETS_API_ERROR';
    throw error;
  }
  return data;
}

async function appendRows(spreadsheetId, sheetName, rows) {
  if (!rows.length) return 0;
  const width = Math.max(1, ...rows.map((row) => Array.isArray(row) ? row.length : 0));
  const full = `${sheets.quoteSheet(sheetName)}!A:${sheets.columnName(width - 1)}`;
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
      const person = result.candidate ? await apollo.resolveDecisionMaker(result.candidate, target.company, target.domain) : null;
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

async function enrichFinalMasterContacts() {
  const master = finalMaster.loadState();
  if (!master.sheetUrl) {
    const error = new Error('The Final Master does not exist yet. Build it before Apollo enrichment.');
    error.code = 'LINKEDIN_FINAL_MASTER_NOT_FOUND';
    throw error;
  }

  const spreadsheetId = sheets.spreadsheetId(master.sheetUrl);
  const rows = await sheets.values(spreadsheetId, `${sheets.quoteSheet(master.sheetName || 'Leads')}!A:W`);
  if (!rows.length) {
    return { selected: 0, enriched: 0, unresolved: 0, skippedComplete: 0, sheetUrl: master.sheetUrl };
  }
  const headers = rows[0].map((value) => String(value || '').trim().toUpperCase());
  const indexOf = (name) => headers.indexOf(name);
  const companyIndex = indexOf('COMPANY NAME');
  const linkedinIndex = indexOf('COMPANY LINKEDIN');
  const websiteIndex = indexOf('WEBSITE');
  const contactNameIndex = indexOf('CONTACT NAME');
  const contactTitleIndex = indexOf('CONTACT TITLE');
  const contactLinkedinIndex = indexOf('CONTACT LINKEDIN');
  const emailIndex = indexOf('EMAIL');
  const phoneIndex = indexOf('PHONE');
  const statusIndex = indexOf('ENRICHMENT STATUS');
  if ([companyIndex, linkedinIndex, contactNameIndex, contactTitleIndex, contactLinkedinIndex, emailIndex, phoneIndex, statusIndex].some((index) => index < 0)) {
    const error = new Error('Final Master contact columns are missing or renamed.');
    error.code = 'LINKEDIN_FINAL_MASTER_CONTACT_COLUMNS_MISSING';
    throw error;
  }

  const max = Math.max(1, Math.min(100, Number(apollo.setting('ULTRON_M3_APOLLO_COMPANY_SEARCH_MAX', '50')) || 50));
  const changes = [];
  const selected = [];
  const unresolved = [];
  let enriched = 0;
  let skippedComplete = 0;

  for (let rowIndex = 1; rowIndex < rows.length && selected.length + unresolved.length < max; rowIndex++) {
    const row = rows[rowIndex] || [];
    const company = String(row[companyIndex] || '').trim();
    const companyLinkedin = String(row[linkedinIndex] || '').trim();
    if (!company || !companyLinkedin) continue;
    const existingEmail = String(row[emailIndex] || '').trim();
    const existingPhone = String(row[phoneIndex] || '').trim();
    if (existingEmail && existingPhone) {
      skippedComplete++;
      continue;
    }

    const domain = finalMaster.hostname(row[websiteIndex] || '');
    try {
      const result = await apollo.searchCompanyDecisionMaker({ company, domain, priorityMode: 'hiring' });
      const person = result.candidate ? await apollo.resolveDecisionMaker(result.candidate, company, domain) : null;
      if (!person?.linkedinUrl) {
        unresolved.push({ company, reason: 'No verified priority decision-maker matched the company.' });
        if (statusIndex >= 0) changes.push({ range: sheets.cellRange(master.sheetName, rowIndex + 1, statusIndex), value: 'NO_MATCH' });
        continue;
      }

      const contact = await apollo.enrich(person.linkedinUrl, { needEmail: !existingEmail, needPhone: !existingPhone });
      const email = existingEmail || String(contact.email || '').trim();
      const phone = existingPhone || String(contact.phone || '').trim();
      const status = email && phone ? 'ENRICHED' : email ? 'EMAIL_ONLY' : phone ? 'PHONE_ONLY' : contact.ambiguous ? 'AMBIGUOUS' : 'NO_MATCH';
      const name = String(person.name || '').trim();
      const title = String(person.title || '').trim();

      changes.push({ range: sheets.cellRange(master.sheetName, rowIndex + 1, contactNameIndex), value: name });
      changes.push({ range: sheets.cellRange(master.sheetName, rowIndex + 1, contactTitleIndex), value: title });
      changes.push({ range: sheets.cellRange(master.sheetName, rowIndex + 1, contactLinkedinIndex), value: person.linkedinUrl });
      if (email) changes.push({ range: sheets.cellRange(master.sheetName, rowIndex + 1, emailIndex), value: email });
      if (phone) changes.push({ range: sheets.cellRange(master.sheetName, rowIndex + 1, phoneIndex), value: phone });
      changes.push({ range: sheets.cellRange(master.sheetName, rowIndex + 1, statusIndex), value: status });

      const key = finalMaster.companyKey({ company, linkedin: companyLinkedin, website: row[websiteIndex] || '' });
      finalMaster.contactUpdate(key, { name, title, linkedin: person.linkedinUrl, email, phone, status });
      selected.push({ company, name, title, linkedin: person.linkedinUrl, status });
      if (email || phone) enriched++;
    } catch (error) {
      if (/APOLLO_(?:PEOPLE_SEARCH_ACCESS_REQUIRED|NOT_CONFIGURED)/.test(String(error.code || '')) || Number(error.status) === 429) throw error;
      unresolved.push({ company, reason: error.message });
      changes.push({ range: sheets.cellRange(master.sheetName, rowIndex + 1, statusIndex), value: 'FAILED' });
    }
    await new Promise((resolve) => setTimeout(resolve, apolloSearchDelayMs()));
  }

  if (changes.length) await sheets.writeCells(spreadsheetId, changes);
  return {
    selected: selected.length,
    enriched,
    unresolved: unresolved.length,
    skippedComplete,
    contacts: selected,
    failures: unresolved,
    sheetUrl: master.sheetUrl,
  };
}

function verifiedRecordSnapshot(record) {
  return {
    entityType: record?.entityType || (record?.jobUrl ? 'company' : ''),
    name: record?.name || '',
    company: record?.company || '',
    role: record?.role || '',
    jobId: record?.jobId || '',
    jobUrl: record?.jobUrl || '',
    linkedin: record?.linkedin || '',
    location: record?.location || '',
    locationEvidenceSource: record?.locationEvidenceSource || '',
    workType: record?.workType || '',
    workTypeEvidenceSource: record?.workTypeEvidenceSource || '',
    employeeCount: record?.employeeCount || null,
    applicants: record?.applicants || '',
    relevanceScore: Number(record?.relevanceScore || 0),
    hiringSignal: record?.hiringSignal || '',
    website: record?.website || '',
    email: record?.email || '',
    phone: record?.phone || '',
    sourceEvidence: [...new Set(record?.sourceEvidence || [])],
  };
}

function isExistingSheetFillRequest(text) {
  const value = String(text || '').trim();
  if (isRequest(value)) return false;
  const state = loadState();
  const mission = [...state.missions].reverse().find((item) =>
    item?.status === 'completed' && Array.isArray(item?.verifiedRecords) && item.verifiedRecords.length
  );
  if (!mission) return false;
  const url = sheets.extractSheetUrl(value);
  const currentSheet = /\b(?:current|same|existing|last|latest)\s+(?:google\s+)?(?:sheet|spreadsheet)\b/i.test(value);
  if (!url && !(currentSheet && workspaceSheetUrl(state))) return false;
  return /\b(?:fill|put|write|copy|add|append|use|move|send)\b/i.test(value)
    || /^https:\/\/docs\.google\.com\/spreadsheets\//i.test(value);
}

async function fillLatestMissionIntoSheet(sheetUrl = null) {
  const state = loadState();
  const mission = [...state.missions].reverse().find((item) =>
    item?.status === 'completed' && Array.isArray(item?.verifiedRecords) && item.verifiedRecords.length
  );
  if (!mission) {
    const error = new Error('No completed LinkedIn mission with reusable verified records is available.');
    error.code = 'LINKEDIN_VERIFIED_RECORDS_NOT_FOUND';
    throw error;
  }

  const resolvedSheetUrl = sheetUrl || workspaceSheetUrl(state) || mission.sheetUrl;
  if (!resolvedSheetUrl) {
    const error = new Error('There is no current LinkedIn Sheet to update. Provide a Google Sheets URL once, then ULTRON can reuse it.');
    error.code = 'LINKEDIN_WORKSPACE_SHEET_NOT_FOUND';
    throw error;
  }

  const request = { ...mission.request, destinationSheetUrl: resolvedSheetUrl };
  const destination = await inspectDestinationSheet(resolvedSheetUrl, request);
  const outputHeaders = ensureHeaders(destination.headers, request);
  const storageHeaders = [...outputHeaders];
  const needsInternalContact = request.entityMode === 'company' && request.wantsContacts;
  if (needsInternalContact && !storageHeaders.some((header) => headerKey(header) === 'contactLinkedin')) {
    storageHeaders.push(INTERNAL_CONTACT_HEADER);
  }
  await syncDestinationHeaders(destination, storageHeaders);

  const existingKeys = destinationExistingKeys(destination, storageHeaders);
  const records = mission.verifiedRecords.filter((record) => {
    const keys = recordDestinationKeys(record);
    const duplicate = keys.some((key) => existingKeys.has(key));
    if (!duplicate) for (const key of keys) existingKeys.add(key);
    return !duplicate;
  });
  const rows = records.map((record) => rowFor(record, storageHeaders));
  const firstAppendedRow = Math.max(destination.lastNonEmptyRow + 1, destination.headerRowNumber + 1);
  const added = await appendRows(destination.spreadsheetId, destination.sheetName, rows);

  if (needsInternalContact) {
    const helperIndex = storageHeaders.findIndex((header) => headerKey(header) === 'contactLinkedin');
    if (helperIndex >= 0) {
      try { await hideInternalContactColumn(destination.spreadsheetId, destination.sheetId, helperIndex); } catch {}
    }
  }

  mission.copiedToSheet = {
    url: resolvedSheetUrl,
    sheetName: destination.sheetName,
    added,
    skippedDuplicates: mission.verifiedRecords.length - records.length,
    copiedAt: nowIso(),
  };
  if (request.entityMode === 'company' && records.length) {
    mission.copiedContactTargets = records.map((record, index) => ({
      rowNumber: firstAppendedRow + index,
      company: record.company,
      companyLinkedin: record.linkedin,
      website: record.website || '',
      domain: websiteDomain(record.website),
    }));
  }
  rememberWorkspaceSheet(resolvedSheetUrl, {
    sheetName: destination.sheetName,
    spreadsheetTitle: destination.spreadsheetTitle,
    entityMode: request.entityMode,
  }, state);
  saveState(state);

  return {
    ok: true,
    sheetUrl: resolvedSheetUrl,
    spreadsheetTitle: destination.spreadsheetTitle,
    sheetName: destination.sheetName,
    added,
    skippedDuplicates: mission.verifiedRecords.length - records.length,
    sourceMissionId: mission.id,
  };
}

function isContinueSearchRequest(text) {
  const value = String(text || '').trim();
  if (!/\b(?:continue|resume|keep\s+searching|search\s+more|find\s+more|more\s+results?|another\s+batch)\b/i.test(value)) return false;
  return Boolean(latestCompletedMission());
}

async function prepareContinuation(text) {
  const state = loadState();
  const mission = [...(state.missions || [])].reverse().find((item) =>
    item?.status === 'completed' && item?.request && !item?.request?.exactUrl
  );
  if (!mission) {
    const error = new Error('There is no completed LinkedIn research mission to continue.');
    error.code = 'LINKEDIN_CONTINUATION_NOT_FOUND';
    throw error;
  }

  const explicitCount = parseExplicitCount(text);
  const explicitSheetUrl = sheets.extractSheetUrl(text);
  const wantsNewSheet = /\b(?:new|separate|fresh)\s+(?:google\s+)?(?:sheet|spreadsheet)\b/i.test(String(text || ''));
  const destinationSheetUrl = explicitSheetUrl || (!wantsNewSheet ? (workspaceSheetUrl(state) || mission.sheetUrl) : null);

  const request = {
    ...mission.request,
    originalMessage: String(text || '').trim(),
    count: explicitCount || Number(mission.requested || mission.request?.count || 25),
    destinationSheetUrl,
    destinationSheet: undefined,
    continueFromPrevious: true,
    usePrevious: false,
    useDefault: true,
    explicitHeaders: undefined,
  };
  return prepare(request);
}

function isConsolidateRequest(text) {
  const value = String(text || '').trim();
  return /\b(?:consolidate|merge|combine|collect)\b[\s\S]{0,80}\b(?:linkedin|results?|missions?|leads?|companies|profiles?)\b/i.test(value)
    || /\b(?:all|every)\s+(?:linkedin\s+)?(?:results?|missions?|leads?)\b[\s\S]{0,60}\b(?:one|single|same|consolidated)\s+(?:google\s+)?(?:sheet|spreadsheet)\b/i.test(value);
}

function consolidatedRecordKey(record) {
  const linkedin = String(record?.linkedin || '').trim().toLowerCase();
  const company = normalizeHeader(record?.company || '');
  const name = normalizeHeader(record?.name || '');
  if (linkedin) return `linkedin:${linkedin}`;
  if (company) return `company:${company}`;
  if (name) return `person:${name}`;
  return '';
}

async function consolidateVerifiedMissions(text = '') {
  const state = loadState();
  const explicitSheetUrl = sheets.extractSheetUrl(text);
  const wantsCurrent = /\b(?:current|same|existing|last|latest)\s+(?:google\s+)?(?:sheet|spreadsheet)\b/i.test(String(text || ''));
  const latest = latestCompletedMission(state);
  const requestedEntity = /\b(?:people|persons?|profiles?|recruiters?|professionals?)\b/i.test(String(text || ''))
    ? 'person'
    : /\b(?:companies|company|employers?|businesses?)\b/i.test(String(text || ''))
      ? 'company'
      : (state.workspace?.entityMode || latest?.request?.entityMode || 'company');

  const missions = (state.missions || []).filter((mission) =>
    mission?.status === 'completed'
    && mission?.request?.entityMode === requestedEntity
    && Array.isArray(mission?.verifiedRecords)
    && mission.verifiedRecords.length
  );
  if (!missions.length) {
    const error = new Error(`No completed LinkedIn ${requestedEntity} missions with verified records are available to consolidate.`);
    error.code = 'LINKEDIN_CONSOLIDATION_EMPTY';
    throw error;
  }

  const byKey = new Map();
  for (const mission of missions) {
    for (const source of mission.verifiedRecords) {
      const record = { ...source, entityType: requestedEntity, sourceMissionId: mission.id };
      const key = consolidatedRecordKey(record);
      if (!key) continue;
      const existing = byKey.get(key);
      if (!existing || Number(record.relevanceScore || 0) > Number(existing.relevanceScore || 0)) {
        byKey.set(key, record);
      }
    }
  }
  const records = [...byKey.values()];
  const templateMission = [...missions].reverse()[0];
  const request = {
    ...templateMission.request,
    entityMode: requestedEntity,
    destinationSheetUrl: null,
    wantsContacts: true,
  };

  const destinationUrl = explicitSheetUrl || (wantsCurrent ? workspaceSheetUrl(state) : null);
  let destination = null;
  let outputHeaders = ensureHeaders(
    requestedEntity === 'company'
      ? [...COMPANY_HEADERS, 'ROLE', 'JOB LINK', 'LOCATION', 'WORK TYPE', 'EMPLOYEES', 'WEBSITE', 'LEAD SCORE']
      : [...PERSON_HEADERS],
    request,
  );
  let sheet;
  let firstAppendedRow = 2;

  if (destinationUrl) {
    destination = await inspectDestinationSheet(destinationUrl, request);
    outputHeaders = ensureHeaders(destination.headers, request);
    await syncDestinationHeaders(destination, outputHeaders);
    sheet = {
      spreadsheetId: destination.spreadsheetId,
      sheetId: destination.sheetId,
      sheetName: destination.sheetName,
      title: destination.spreadsheetTitle,
      url: destinationUrl,
    };
    firstAppendedRow = Math.max(destination.lastNonEmptyRow + 1, destination.headerRowNumber + 1);
  } else {
    const title = `ULTRON LinkedIn Consolidated - ${requestedEntity === 'company' ? 'Companies' : 'People'} - ${new Date().toISOString().slice(0, 10)}`;
    sheet = await v2.createSpreadsheet(title, outputHeaders, records.length);
  }

  const existingKeys = destination ? destinationExistingKeys(destination, outputHeaders) : new Set();
  const writeRecords = records.filter((record) => {
    const keys = recordDestinationKeys(record);
    const duplicate = keys.some((key) => existingKeys.has(key));
    if (!duplicate) for (const key of keys) existingKeys.add(key);
    return !duplicate;
  });
  const added = await appendRows(sheet.spreadsheetId, sheet.sheetName, writeRecords.map((record) => rowFor(record, outputHeaders)));

  rememberWorkspaceSheet(sheet.url, {
    sheetName: sheet.sheetName,
    spreadsheetTitle: sheet.title,
    entityMode: requestedEntity,
  }, state);
  state.consolidated = {
    sheetUrl: sheet.url,
    sheetName: sheet.sheetName,
    entityMode: requestedEntity,
    missions: missions.length,
    uniqueRecords: records.length,
    added,
    updatedAt: nowIso(),
  };
  saveState(state);

  return {
    ok: true,
    sheetUrl: sheet.url,
    spreadsheetTitle: sheet.title,
    sheetName: sheet.sheetName,
    entityMode: requestedEntity,
    missions: missions.length,
    uniqueRecords: records.length,
    added,
    skippedDuplicates: records.length - writeRecords.length,
    firstAppendedRow,
  };
}

function isDedupeSheetRequest(text) {
  const value = String(text || '').trim();
  return /\b(?:dedupe|de-duplicate|remove\s+duplicates?|clean\s+duplicates?)\b/i.test(value)
    && /\b(?:sheet|spreadsheet|linkedin\s+results?)\b/i.test(value);
}

async function dedupeWorkspaceSheet(text = '') {
  const state = loadState();
  const sheetUrl = sheets.extractSheetUrl(text) || workspaceSheetUrl(state);
  if (!sheetUrl) {
    const error = new Error('There is no current LinkedIn Sheet to dedupe. Provide a Google Sheets URL.');
    error.code = 'LINKEDIN_WORKSPACE_SHEET_NOT_FOUND';
    throw error;
  }

  const latest = latestCompletedMission(state);
  const request = latest?.request || { entityMode: state.workspace?.entityMode || 'company', wantsContacts: true, filters: {} };
  const destination = await inspectDestinationSheet(sheetUrl, request);
  const headers = destination.headers;
  const linkedinIndex = headers.findIndex((header) => headerKey(header) === 'linkedin');
  const jobIndex = headers.findIndex((header) => headerKey(header) === 'jobLink');
  const companyIndex = headers.findIndex((header) => headerKey(header) === 'company');
  const nameIndex = headers.findIndex((header) => headerKey(header) === 'name');

  const seen = new Set();
  const duplicateRows = [];
  for (let index = destination.headerRowNumber; index < destination.rows.length; index++) {
    const row = destination.rows[index] || [];
    const keys = [];
    if (linkedinIndex >= 0 && row[linkedinIndex]) keys.push(`linkedin:${String(row[linkedinIndex]).trim().toLowerCase()}`);
    if (jobIndex >= 0 && row[jobIndex]) keys.push(`job:${String(row[jobIndex]).trim().toLowerCase()}`);
    if (companyIndex >= 0 && row[companyIndex]) keys.push(`company:${normalizeHeader(row[companyIndex])}`);
    if (!keys.length && nameIndex >= 0 && row[nameIndex]) keys.push(`name:${normalizeHeader(row[nameIndex])}`);
    if (!keys.length) continue;
    if (keys.some((key) => seen.has(key))) {
      duplicateRows.push(index);
      continue;
    }
    for (const key of keys) seen.add(key);
  }

  if (duplicateRows.length) {
    const requests = duplicateRows
      .sort((a, b) => b - a)
      .map((rowIndex) => ({
        deleteDimension: {
          range: {
            sheetId: destination.sheetId,
            dimension: 'ROWS',
            startIndex: rowIndex,
            endIndex: rowIndex + 1,
          },
        },
      }));
    await apiRequest(`${API}/${encodeURIComponent(destination.spreadsheetId)}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ requests }),
    });
  }

  rememberWorkspaceSheet(sheetUrl, {
    sheetName: destination.sheetName,
    spreadsheetTitle: destination.spreadsheetTitle,
    entityMode: request.entityMode,
  }, state);
  saveState(state);
  return {
    ok: true,
    sheetUrl,
    spreadsheetTitle: destination.spreadsheetTitle,
    sheetName: destination.sheetName,
    removed: duplicateRows.length,
  };
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

function isBuildFinalMasterRequest(text) {
  return /\b(?:build|create|make|rebuild|migrate|generate)\b[\s\S]{0,40}\b(?:final\s+master|final\s+(?:lead\s+)?database|clean\s+master)\b/i.test(String(text || ''));
}

function historicalVerifiedCompanyRecords(options = {}) {
  const state = loadState();
  const topic = String(options.topic || 'SAP');
  const workType = options.workType === undefined ? 'remote' : options.workType;
  const employeeMax = options.employeeMax === undefined ? 1000 : options.employeeMax;
  const records = [];
  for (const mission of state.missions || []) {
    if (mission?.status !== 'completed' || mission?.request?.entityMode !== 'company') continue;
    if (topic && !String(mission.request?.topic || '').toLowerCase().startsWith(topic.toLowerCase())) continue;
    for (const record of mission.verifiedRecords || []) {
      if (!finalMaster.qualifies(record, { topic, workType, employeeMax })) continue;
      records.push({ ...record, sourceMissionId: mission.id, sourceMissionCreatedAt: mission.createdAt });
    }
  }
  const byKey = new Map();
  for (const record of records) {
    const key = finalMaster.companyKey(record);
    if (!key) continue;
    const previous = byKey.get(key);
    if (!previous || Number(record.relevanceScore || 0) > Number(previous.relevanceScore || 0)) byKey.set(key, record);
  }
  return [...byKey.values()];
}

async function buildFinalMaster(text = '') {
  const existingUrl = finalMaster.masterSheetUrl();
  if (existingUrl && !/\b(?:rebuild|replace|new)\b/i.test(String(text || ''))) {
    return {
      ok: true,
      sheetUrl: existingUrl,
      spreadsheetTitle: finalMaster.loadState().spreadsheetTitle,
      sheetName: finalMaster.loadState().sheetName,
      added: 0,
      uniqueRecords: finalMaster.masterCount(),
      alreadyExists: true,
    };
  }

  const records = historicalVerifiedCompanyRecords({ topic: 'SAP', workType: 'remote', employeeMax: 1000 });
  const sheet = await v2.createSpreadsheet('ULTRON LinkedIn Final Lead Master', finalMaster.FINAL_MASTER_HEADERS, Math.max(100, records.length + 20));
  await sheets.ensureGridSize(sheet.spreadsheetId, sheet.sheetId, {
    minColumns: finalMaster.FINAL_MASTER_HEADERS.length,
    minRows: Math.max(200, records.length + 10),
  });
  const rows = records.map((record) => finalMaster.rowFor(record, { missionId: record.sourceMissionId, firstSeenAt: record.sourceMissionCreatedAt }));
  const added = await appendRows(sheet.spreadsheetId, sheet.sheetName, rows);
  finalMaster.setMasterSheet(sheet);
  finalMaster.registerRecords(records, { missionId: 'historical-migration' });

  const state = loadState();
  rememberWorkspaceSheet(sheet.url, {
    sheetName: sheet.sheetName,
    spreadsheetTitle: sheet.title,
    entityMode: 'company',
  }, state);
  saveState(state);

  return {
    ok: true,
    sheetUrl: sheet.url,
    spreadsheetTitle: sheet.title,
    sheetName: sheet.sheetName,
    added,
    uniqueRecords: records.length,
    alreadyExists: false,
  };
}

async function run(request, headers) {
  if (request?.entityMode === 'company') {
    request.allowPreviouslySeenCompanies = Boolean(request.allowPreviouslySeenCompanies || finalMaster.allowRepeatFromText(request.originalMessage));
    if ((request.useFinalMaster || request.targetMode === 'master_total') && !finalMaster.masterSheetUrl()) {
      await buildFinalMaster('build final master');
    }
    if (request.targetMode === 'master_total' && request.targetTotal) {
      const target = finalMaster.remainingForTarget(request.targetTotal);
      request.count = target.remaining;
      request.masterTarget = target;
    }
    if (request.useFinalMaster || request.targetMode === 'master_total') {
      request.destinationSheetUrl = finalMaster.masterSheetUrl() || request.destinationSheetUrl;
    }
  }

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

    missionRunner.persistResearch(researched);
    const persisted = loadState();
    const checkpointMission = persisted.missions.find(item => item.id === mission.id);
    if (checkpointMission) Object.assign(checkpointMission, { verifiedRecords: researched.records, status: 'writing_sheet' });
    saveState(persisted);
    const title = `ULTRON LinkedIn - ${String(request.topic || request.entityMode).replace(/[^a-z0-9 ()&+._-]+/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 65)} - ${new Date().toISOString().slice(0, 10)}`;
    const needsInternalContact = request.entityMode === 'company' && request.wantsContacts;

    let destination = null;
    let destinationWriteError = null;
    let outputHeaders = ensureHeaders(headers, request);
    let storageHeaders = [...outputHeaders];
    if (needsInternalContact && !storageHeaders.some((header) => headerKey(header) === 'contactLinkedin')) {
      storageHeaders.push(INTERNAL_CONTACT_HEADER);
    }

    let sheet;
    let recordsToWrite = researched.records.slice();
    let duplicateRowsSkipped = 0;
    let firstAppendedRow = 2;
    let added = 0;

    try {
      if (request.destinationSheetUrl) {
        destination = await inspectDestinationSheet(request.destinationSheetUrl, request);
        outputHeaders = ensureHeaders(destination.headers, request);
        storageHeaders = [...outputHeaders];
        if (needsInternalContact && !storageHeaders.some((header) => headerKey(header) === 'contactLinkedin')) {
          storageHeaders.push(INTERNAL_CONTACT_HEADER);
        }

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
      }

      await sheets.ensureGridSize(sheet.spreadsheetId, sheet.sheetId, {
        minColumns: Math.max(1, storageHeaders.length),
        minRows: Math.max(200, firstAppendedRow + recordsToWrite.length + 5),
      });
      const rows = recordsToWrite.map((record) => rowFor(record, storageHeaders));
      added = await appendRows(sheet.spreadsheetId, sheet.sheetName, rows);
    } catch (error) {
      if (!request.destinationSheetUrl || !isGoogleSheetsError(error)) throw error;

      destinationWriteError = sheetErrorSnapshot(error);
      destination = null;
      duplicateRowsSkipped = 0;
      recordsToWrite = researched.records.slice();
      outputHeaders = ensureHeaders(headers, request);
      storageHeaders = [...outputHeaders];
      if (needsInternalContact && !storageHeaders.some((header) => headerKey(header) === 'contactLinkedin')) {
        storageHeaders.push(INTERNAL_CONTACT_HEADER);
      }

      const recoveryTitle = `${title} - Recovery`;
      try {
        sheet = await v2.createSpreadsheet(recoveryTitle, storageHeaders, request.count);
        firstAppendedRow = 2;
        const rows = recordsToWrite.map((record) => rowFor(record, storageHeaders));
        added = await appendRows(sheet.spreadsheetId, sheet.sheetName, rows);
      } catch (fallbackError) {
        const combined = new Error(
          `Master Sheet failed: ${destinationWriteError.message}. Recovery Sheet also failed: ${fallbackError.message}`
        );
        combined.code = fallbackError.code || error.code || 'GOOGLE_SHEETS_API_ERROR';
        combined.status = fallbackError.status || error.status || null;
        throw combined;
      }
    }

    if (needsInternalContact) {
      const helperIndex = storageHeaders.findIndex((header) => headerKey(header) === 'contactLinkedin');
      if (helperIndex >= 0) {
        try { await hideInternalContactColumn(sheet.spreadsheetId, sheet.sheetId, helperIndex); } catch {}
      }
    }

    mission.status = 'completed';
    mission.completedAt = nowIso();
    mission.criteriaSignature = criteriaSignature(request);
    mission.sheetUrl = sheet.url;
    mission.sheetName = sheet.sheetName;
    mission.spreadsheetTitle = sheet.title;
    mission.headers = outputHeaders;
    mission.storageHeaders = storageHeaders;
    mission.destinationMode = destination
      ? 'existing-sheet'
      : destinationWriteError
        ? 'recovery-sheet'
        : 'created-sheet';
    mission.requestedDestinationSheetUrl = request.destinationSheetUrl || null;
    mission.destinationWriteError = destinationWriteError;
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
    mission.verifiedRecords = researched.records.map(verifiedRecordSnapshot);
    mission.safety = policy.status();
    mission.globalSeenSkipped = Number(researched.toolCalls?.globallySeenSkipped || 0);
    mission.masterTarget = request.masterTarget || null;

    if (request.entityMode === 'company' && recordsToWrite.length) {
      finalMaster.registerRecords(recordsToWrite, { missionId: mission.id });
      if (request.useFinalMaster || request.targetMode === 'master_total') {
        finalMaster.setMasterSheet({
          url: sheet.url,
          spreadsheetId: sheet.spreadsheetId,
          sheetName: sheet.sheetName,
          title: sheet.title,
        });
      }
    }

    const latest = loadState();
    const target = latest.missions.find((item) => item.id === mission.id);
    if (target) Object.assign(target, mission);
    latest.pending = null;
    if (!destinationWriteError) {
      rememberWorkspaceSheet(sheet.url, {
        sheetName: sheet.sheetName,
        spreadsheetTitle: sheet.title,
        entityMode: request.entityMode,
      }, latest);
    }
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
  const state = loadState();
  return {
    readyForRouting: true,
    stateFile: STATE_FILE,
    workspace: state.workspace || null,
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
      hiring: ['director/founder/owner', 'lead recruiter/general manager', 'HR recruiter'],
      general: ['director/founder/owner', 'lead recruiter/general manager', 'HR recruiter'],
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
  const masterTargetText = mission.masterTarget
    ? ` Master target: ${mission.masterTarget.desired} unique companies total; ${mission.masterTarget.current} already existed before this run; ${mission.masterTarget.remaining} additional unique companies were required.`
    : '';
  const globalSkipText = mission.globalSeenSkipped
    ? ` Global dedupe skipped ${mission.globalSeenSkipped} previously seen compan${mission.globalSeenSkipped === 1 ? 'y' : 'ies'}.`
    : '';
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
    : mission.destinationMode === 'recovery-sheet'
      ? ` The requested master Sheet could not be written (${mission.destinationWriteError?.code || 'GOOGLE_SHEETS_API_ERROR'}: ${mission.destinationWriteError?.message || 'unknown Sheets error'}). I preserved the verified results in this recovery Sheet instead; your remembered master Sheet was not changed.`
      : '';
  return `LinkedIn-only mission complete, Sir. Added ${mission.added} records to “${mission.spreadsheetTitle}”.${destination}${masterTargetText}${globalSkipText} Discovery and filter verification used only the authenticated LinkedIn account tool; Google Jobs, Maps, TinyFish, public-index SerpApi and Apollo were not used for discovery. Average quality score ${mission.averageScore}/100.${jobTrace}${hardGate}${contact}${shortfall}${budget}${searchWarning} ${mission.sheetUrl}`;
}

module.exports = {
  COMPANY_HEADERS,
  PERSON_HEADERS,
  INTERNAL_CONTACT_HEADER,
  isRequest,
  parseCount,
  parseExplicitCount,
  parseRequest,
  parseEmployeeRange,
  parseFilters,
  hiringIntentFromText,
  requestTopic,
  locationScopeFromText,
  headerKey,
  ensureHeaders,
  pendingRequest,
  latestCompletedMission,
  workspaceSheetUrl,
  isGoogleSheetsError,
  sheetErrorSnapshot,
  rememberWorkspaceSheet,
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
  joeyismJobToDetail,
  joeyismCompanyText,
  criteriaSignature,
  previousCheckedJobIds,
  reconsiderRejectedCandidates,
  companyMission,
  personSearchPlan,
  personMission,
  exactMission,
  contactRemark,
  verifiedRecordSnapshot,
  isExistingSheetFillRequest,
  fillLatestMissionIntoSheet,
  isContinueSearchRequest,
  prepareContinuation,
  isConsolidateRequest,
  consolidatedRecordKey,
  consolidateVerifiedMissions,
  isDedupeSheetRequest,
  dedupeWorkspaceSheet,
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
  enrichFinalMasterContacts,
  isBuildFinalMasterRequest,
  historicalVerifiedCompanyRecords,
  buildFinalMaster,
  run,
  latestMission,
  status,
  statusText,
  formatMission,
};
