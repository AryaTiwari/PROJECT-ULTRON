const googleAuth = require('./google-sheets-auth');
const sheets = require('./google-sheets-operator');
const web = require('./web');
const apollo = require('./apollo-enrichment');
const leadEnrichment = require('./lead-enrichment-operator');
const paidTools = require('./paid-tool-approval');

const API = 'https://sheets.googleapis.com/v4/spreadsheets';
const CANONICAL_HEADERS = ['Name', 'Company', 'Role', 'LinkedIn Profile URL', 'Phone No', 'Email', 'Source'];
const HEADER_KEYS = ['name', 'company', 'role', 'linkedin', 'phone', 'email', 'source'];

function normalizeHeader(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function keyForHeader(value) {
  const h = normalizeHeader(value);
  if (!h) return null;
  if (/^(?:name|full name|person name|lead name|contact name)$/.test(h)) return 'name';
  if (/^(?:company|company name|organization|organisation|employer)$/.test(h)) return 'company';
  if (/^(?:role|job title|title|designation|position|current role)$/.test(h)) return 'role';
  if (sheets.headerScore(value, 'linkedin') > 0) return 'linkedin';
  if (sheets.headerScore(value, 'phone') > 0) return 'phone';
  if (sheets.headerScore(value, 'email') > 0) return 'email';
  if (/^(?:source|source url|research source|found via|reference|reference url)$/.test(h)) return 'source';
  return null;
}

function parseCount(text) {
  const value = String(text || '');
  const direct = value.match(/\b(\d{1,3})\s+(?:new\s+)?(?:leads?|prospects?|people|profiles?|contacts?|founders?|recruiters?|managers?)\b/i);
  const nearFind = value.match(/\b(?:find|research|discover|source|collect|get)\s+(?:me\s+)?(\d{1,3})\b/i);
  const count = Number(direct?.[1] || nearFind?.[1] || 20);
  return Math.max(1, Math.min(100, Number.isFinite(count) ? count : 20));
}

function wantsContactEnrichment(text) {
  return /\b(?:apollo|enrich(?:ment)?|phone|mobile|email|contact details?|contact info(?:rmation)?)\b/i.test(String(text || ''));
}

function isResearchRequest(text) {
  const value = String(text || '').trim();
  const hasSheet = /\b(?:google\s+)?sheets?|spreadsheet\b/i.test(value) || /docs\.google\.com\/spreadsheets/i.test(value);
  const leadNoun = /\b(?:leads?|prospects?|decision makers?|founders?|recruiters?|hiring managers?|hr managers?|people|profiles?|contacts?)\b/i.test(value);
  const discovery = /\b(?:find|research|discover|source|collect|build|generate|get|look\s*up)\b/i.test(value);
  const pureEnrichment = /\bapollo\b/i.test(value) && /\b(?:enrich|fill|phone|email)\b/i.test(value) && !/\b(?:find|research|discover|source|collect|build|generate)\b/i.test(value);
  return hasSheet && leadNoun && discovery && !pureEnrichment;
}

function cleanCriteria(text) {
  let value = String(text || '')
    .replace(/https:\/\/docs\.google\.com\/spreadsheets\/d\/[a-zA-Z0-9_-]+[^\s<>'"`]*/gi, ' ')
    .replace(/^(?:hey\s+)?ultron\b[\s,:;.!-]*/i, '')
    .replace(/\b(?:find|research|discover|source|collect|get|build|generate|look\s*up)\s+(?:me\s+)?\d{0,3}\s*/i, ' ')
    .replace(/\b\d{1,3}\s+(?:new\s+)?(?:leads?|prospects?|people|profiles?|contacts?)\b/gi, ' ')
    .replace(/\b(?:leads?|prospects?)\b/gi, ' ')
    .replace(/\b(?:and\s+)?(?:fill|write|add|put|save)(?:\s+them)?\s+(?:into|in|to)?\s*(?:this|the|my|our)?\s*(?:google\s+)?(?:sheet|spreadsheet)\b[\s\S]*$/i, ' ')
    .replace(/\b(?:with|including)\s+(?:their\s+)?(?:phone|mobile|email|contact details?|contact information)(?:\s+and\s+(?:phone|mobile|email))?\b/gi, ' ')
    .replace(/\b(?:using|through|via)\s+apollo\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  value = value.replace(/^(?:for|of)\s+/i, '').trim();
  return value || 'business professionals';
}

function parseRequest(text) {
  if (!isResearchRequest(text)) return null;
  return {
    sheetUrl: sheets.extractSheetUrl(text),
    invalidUrl: !sheets.extractSheetUrl(text),
    count: parseCount(text),
    criteria: cleanCriteria(text),
    wantsContactEnrichment: wantsContactEnrichment(text),
    originalMessage: String(text || '').trim(),
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

async function metadata(id) {
  return request(`${API}/${encodeURIComponent(id)}?includeGridData=false&fields=${encodeURIComponent('properties.title,sheets.properties(sheetId,title,index)')}`);
}

async function values(id, range) {
  const data = await request(`${API}/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`);
  return data.values || [];
}

async function appendRows(id, sheetName, rows) {
  if (!rows.length) return { updatedRows: 0 };
  const range = `${sheets.quoteSheet(sheetName)}!A:ZZ`;
  const url = `${API}/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  const data = await request(url, { method: 'POST', body: JSON.stringify({ majorDimension: 'ROWS', values: rows }) });
  return { updatedRows: Number(data?.updates?.updatedRows || rows.length), raw: data };
}

function headerLayout(rows) {
  let best = null;
  for (let r = 0; r < Math.min(20, rows.length || 1); r++) {
    const row = rows[r] || [];
    const map = {};
    row.forEach((value, index) => {
      const key = keyForHeader(value);
      if (key && map[key] == null) map[key] = index;
    });
    const score = Object.keys(map).length;
    if (!best || score > best.score) best = { rowIndex: r, rowNumber: r + 1, map, row, score };
  }
  return best && best.score >= 2 ? best : null;
}

async function ensureSheetLayout(sheetUrl) {
  const id = sheets.spreadsheetId(sheetUrl);
  const meta = await metadata(id);
  const tabs = (meta.sheets || []).map((sheet) => sheet?.properties?.title).filter(Boolean);
  if (!tabs.length) throw new Error('The spreadsheet has no usable sheet tabs.');

  let selected = null;
  for (const title of tabs) {
    const preview = await values(id, `${sheets.quoteSheet(title)}!A1:ZZ40`);
    const layout = headerLayout(preview);
    if (layout && (!selected || layout.score > selected.layout.score)) selected = { title, preview, layout };
  }

  if (!selected) {
    const title = tabs[0];
    await request(`${API}/${encodeURIComponent(id)}/values/${encodeURIComponent(`${sheets.quoteSheet(title)}!A1:G1`) }?valueInputOption=RAW`, {
      method: 'PUT',
      body: JSON.stringify({ values: [CANONICAL_HEADERS] }),
    });
    selected = { title, preview: [CANONICAL_HEADERS], layout: headerLayout([CANONICAL_HEADERS]) };
  }

  const current = selected.layout.row.slice();
  const map = { ...selected.layout.map };
  let nextIndex = Math.max(current.length, ...Object.values(map).map(Number).filter(Number.isFinite).map((n) => n + 1), 0);
  const additions = [];
  HEADER_KEYS.forEach((key, i) => {
    if (map[key] != null) return;
    map[key] = nextIndex;
    additions.push({ range: sheets.cellRange(selected.title, selected.layout.rowNumber, nextIndex), value: CANONICAL_HEADERS[i] });
    nextIndex++;
  });
  if (additions.length) await sheets.writeCells(id, additions);

  const rows = await values(id, `${sheets.quoteSheet(selected.title)}!A:ZZ`);
  return {
    spreadsheetId: id,
    spreadsheetTitle: meta?.properties?.title || '',
    sheetName: selected.title,
    headerRowNumber: selected.layout.rowNumber,
    headerRowIndex: selected.layout.rowIndex,
    map,
    rows,
    columnCount: nextIndex,
  };
}

function cleanLinkedInUrl(value) {
  return apollo.normalizeLinkedIn(value);
}

function parseLead(result, query) {
  const linkedin = cleanLinkedInUrl(result?.url);
  if (!linkedin) return null;
  const rawTitle = String(result?.title || '').replace(/\s*[|•-]\s*LinkedIn\s*$/i, '').trim();
  const parts = rawTitle.split(/\s+(?:\||•|–|—|-)+\s+/).map((part) => part.trim()).filter(Boolean);
  let name = parts[0] || '';
  let role = parts[1] || '';
  let company = parts[2] || '';
  const at = role.match(/^(.+?)\s+at\s+(.+)$/i);
  if (at) { role = at[1].trim(); company = company || at[2].trim(); }
  if (/linkedin|profile|jobs?/i.test(name) || name.length > 90) name = '';
  const snippet = String(result?.snippet || '').trim();
  const email = leadEnrichment.extractRowEmail([snippet]) || '';
  const phone = leadEnrichment.extractRowPhone([snippet]) || '';
  return {
    name,
    company,
    role,
    linkedin,
    phone,
    email,
    source: String(result?.url || '').trim(),
    snippet,
    query,
  };
}

function researchQueries(criteria) {
  const c = String(criteria || '').trim();
  const words = c.split(/\s+/).filter(Boolean);
  const focused = words.slice(0, 8).join(' ');
  const tail = words.slice(-6).join(' ');
  return [...new Set([
    `site:linkedin.com/in ${c}`,
    `site:linkedin.com/in "${focused}"`,
    `${c} LinkedIn profile`,
    `site:linkedin.com/in ${focused} ${tail}`.trim(),
    `LinkedIn ${c} profile`,
    `site:linkedin.com/in ${c} hiring professional`,
    `site:linkedin.com/in ${c} manager`,
    `site:linkedin.com/in ${c} founder recruiter`,
  ])];
}

async function researchLeads(criteria, count) {
  paidTools.assertPermitted('tinyfish');
  const leads = [];
  const seen = new Set();
  const queries = researchQueries(criteria);
  const maxQueries = Math.min(8, Math.max(2, Math.ceil(count / 7) + 1));
  const failures = [];

  for (const query of queries.slice(0, maxQueries)) {
    if (leads.length >= count) break;
    try {
      const result = await web.searchWeb(query, { limit: 10 });
      for (const item of result.results || []) {
        const lead = parseLead(item, query);
        if (!lead || seen.has(lead.linkedin)) continue;
        seen.add(lead.linkedin);
        leads.push(lead);
        if (leads.length >= count) break;
      }
    } catch (error) {
      failures.push(`${query}: ${error.message}`);
    }
  }
  return { leads: leads.slice(0, count), queriesRun: Math.min(maxQueries, queries.length), failures };
}

function existingLinkedIns(layout) {
  const set = new Set();
  const idx = layout.map.linkedin;
  for (let r = layout.headerRowIndex + 1; r < layout.rows.length; r++) {
    const url = cleanLinkedInUrl(layout.rows[r]?.[idx]);
    if (url) set.add(url);
  }
  return set;
}

function rowForLead(lead, layout) {
  const row = Array(layout.columnCount).fill('');
  const valuesByKey = {
    name: lead.name,
    company: lead.company,
    role: lead.role,
    linkedin: lead.linkedin,
    phone: lead.phone,
    email: lead.email,
    source: lead.source,
  };
  for (const [key, value] of Object.entries(valuesByKey)) {
    const index = layout.map[key];
    if (Number.isInteger(index) && index >= 0) row[index] = value || '';
  }
  return row;
}

async function run(requestData) {
  if (!requestData?.sheetUrl) throw new Error('A full Google Sheet URL is required for lead research.');
  const layout = await ensureSheetLayout(requestData.sheetUrl);
  const researched = await researchLeads(requestData.criteria, requestData.count);
  const existing = existingLinkedIns(layout);
  const fresh = researched.leads.filter((lead) => !existing.has(lead.linkedin));
  const duplicateCount = researched.leads.length - fresh.length;
  const rows = fresh.map((lead) => rowForLead(lead, layout));
  const written = await appendRows(layout.spreadsheetId, layout.sheetName, rows);
  const publicEmails = fresh.filter((lead) => lead.email).length;
  const publicPhones = fresh.filter((lead) => lead.phone).length;
  const missingContacts = fresh.filter((lead) => !lead.email || !lead.phone).length;
  return {
    ok: true,
    sheetUrl: requestData.sheetUrl,
    spreadsheetTitle: layout.spreadsheetTitle,
    sheetName: layout.sheetName,
    criteria: requestData.criteria,
    requested: requestData.count,
    discovered: researched.leads.length,
    added: written.updatedRows,
    duplicateCount,
    publicEmails,
    publicPhones,
    missingContacts,
    wantsContactEnrichment: Boolean(requestData.wantsContactEnrichment),
    queriesRun: researched.queriesRun,
    searchFailures: researched.failures.length,
  };
}

function formatResult(result) {
  const shortfall = result.discovered < result.requested ? ` I found ${result.discovered} qualifying public LinkedIn profiles in this pass, below the requested ${result.requested}.` : '';
  const duplicate = result.duplicateCount ? ` ${result.duplicateCount} duplicate profile${result.duplicateCount === 1 ? ' was' : 's were'} skipped.` : '';
  const contacts = ` Public research supplied ${result.publicEmails} email${result.publicEmails === 1 ? '' : 's'} and ${result.publicPhones} phone${result.publicPhones === 1 ? '' : 's'} without Apollo.`;
  return `Done, Sir. Added ${result.added} new lead${result.added === 1 ? '' : 's'} to ${result.sheetName} for “${result.criteria}”.${duplicate}${contacts}${shortfall}`;
}

module.exports = {
  CANONICAL_HEADERS,
  isResearchRequest,
  parseRequest,
  parseCount,
  cleanCriteria,
  wantsContactEnrichment,
  keyForHeader,
  headerLayout,
  parseLead,
  researchQueries,
  run,
  formatResult,
};
