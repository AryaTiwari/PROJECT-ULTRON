const fs = require('fs');
const path = require('path');
const config = require('./config');

const ROOT = path.join(config.projectRoot, '.ultron', 'linkedin-final-master');
const STATE_FILE = path.join(ROOT, 'state.json');

const FINAL_MASTER_HEADERS = [
  'COMPANY NAME',
  'COMPANY LINKEDIN',
  'WEBSITE',
  'PRIMARY SAP ROLE',
  'PRIMARY JOB LINK',
  'JOB LOCATION',
  'STATE',
  'WORK TYPE',
  'EMPLOYEE RANGE',
  'HIRING SIGNAL',
  'OTHER MATCHING SAP JOBS',
  'FIRST FOUND',
  'LAST VERIFIED',
  'SOURCE MISSION',
  'LEAD STATUS',
  'CONTACT NAME',
  'CONTACT TITLE',
  'CONTACT LINKEDIN',
  'EMAIL',
  'PHONE',
  'ENRICHMENT STATUS',
  'NOTES',
  'NEXT ACTION',
];

function nowIso() { return new Date().toISOString(); }

function defaultState() {
  return {
    version: 1,
    sheetUrl: null,
    spreadsheetId: null,
    sheetName: 'Leads',
    spreadsheetTitle: 'ULTRON LinkedIn Final Lead Master',
    updatedAt: null,
    companies: {},
  };
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return defaultState();
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { ...defaultState(), ...parsed, companies: parsed.companies || {} };
  } catch {
    return defaultState();
  }
}

function saveState(state) {
  fs.mkdirSync(ROOT, { recursive: true });
  state.updatedAt = nowIso();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  try { fs.chmodSync(STATE_FILE, 0o600); } catch {}
  return state;
}

function normalizeLinkedIn(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/https?:\/\/(?:www\.)?linkedin\.com\/company\/([^/?#]+)/i);
  return match ? `https://www.linkedin.com/company/${match[1].toLowerCase()}` : '';
}

function normalizeName(value) {
  return String(value || '')
    .replace(/\b\d[\d,.]*\s+followers?\b/gi, ' ')
    .replace(/\([^)]*followers?[^)]*\)/gi, ' ')
    .replace(/&/g, ' and ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hostname(value) {
  let raw = String(value || '').trim();
  if (!raw) return '';
  try {
    if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function companyKey(record = {}) {
  const linkedin = normalizeLinkedIn(record.linkedin || record.companyLinkedin || record.companyLink);
  if (linkedin) return 'linkedin:' + linkedin;
  const domain = hostname(record.website || record.domain);
  if (domain) return 'domain:' + domain;
  const company = normalizeName(record.company || record.companyName || record.name);
  return company ? 'company:' + company : '';
}

function isCompanyRecord(record = {}) {
  return Boolean(normalizeLinkedIn(record.linkedin || record.companyLinkedin || record.companyLink))
    && Boolean(String(record.company || record.companyName || record.name || '').trim());
}

function sapEvidence(record = {}) {
  return [
    record.role,
    record.hiringSignal,
    record.jobTitle,
    record.primaryRole,
    record.jobUrl,
  ].filter(Boolean).join(' ');
}

function hasSapOpening(record = {}) {
  return /\bSAP\b|\bABAP\b|\bFICO\b|\bS\/?4HANA\b|\bSuccessFactors?\b|\bAriba\b|\bBTP\b|\bCPI\b|\bEWM\b|\bHANA\b|\bSAP\s+(?:MM|SD|TM|BW|Basis|Security)\b/i.test(sapEvidence(record));
}

function employeeMaximum(record = {}) {
  const value = record.employeeCount;
  if (value && typeof value === 'object') {
    if (Number.isFinite(Number(value.max))) return Number(value.max);
    if (Number.isFinite(Number(value.min)) && value.max == null) return Number.POSITIVE_INFINITY;
  }
  const raw = String(record.employeeRange || record.employees || value || '').replace(/,/g, '');
  const range = raw.match(/(\d+)\s*(?:-|to)\s*(\d+)/i);
  if (range) return Number(range[2]);
  const plus = raw.match(/(\d+)\s*\+/);
  if (plus) return Number.POSITIVE_INFINITY;
  const one = raw.match(/\b(\d+)\b/);
  return one ? Number(one[1]) : null;
}

function qualifies(record = {}, requirements = {}) {
  if (!isCompanyRecord(record)) return false;
  if (requirements.topic && /^sap(?:\s|$)/i.test(String(requirements.topic)) && !hasSapOpening(record)) return false;
  if (requirements.workType && String(record.workType || '').toLowerCase() !== String(requirements.workType).toLowerCase()) return false;
  if (requirements.employeeMax != null) {
    const max = employeeMaximum(record);
    if (max == null || max > Number(requirements.employeeMax)) return false;
  }
  return Boolean(record.jobUrl || record.jobId || record.hiringSignal);
}

function allowRepeatFromText(text) {
  return /\b(?:include|show|use|allow|repeat|return)\b[\s\S]{0,35}\b(?:previously\s+seen|already\s+seen|old|previous|existing|duplicate)\s+(?:companies|leads|results)\b|\binclude\s+duplicates\b/i.test(String(text || ''));
}

function seen(record, state = loadState()) {
  const key = companyKey(record);
  return Boolean(key && state.companies[key]);
}

function filterUnseen(records = [], options = {}) {
  const state = options.state || loadState();
  if (options.allowPreviouslySeen) return { records: records.slice(), skipped: [] };
  const fresh = [];
  const skipped = [];
  const local = new Set();
  for (const record of records) {
    const key = companyKey(record);
    if (!key) continue;
    if (state.companies[key] || local.has(key)) {
      skipped.push(record);
      continue;
    }
    local.add(key);
    fresh.push(record);
  }
  return { records: fresh, skipped };
}

function registerRecords(records = [], metadata = {}) {
  const state = loadState();
  for (const record of records) {
    const key = companyKey(record);
    if (!key) continue;
    const previous = state.companies[key] || {};
    const jobs = Array.isArray(previous.jobs) ? previous.jobs.slice() : [];
    if (record.jobUrl && !jobs.some((job) => job.jobUrl === record.jobUrl)) {
      jobs.push({ role: record.role || '', jobUrl: record.jobUrl, location: record.location || '', verifiedAt: nowIso() });
    }
    state.companies[key] = {
      ...previous,
      key,
      company: record.company || previous.company || '',
      linkedin: normalizeLinkedIn(record.linkedin) || previous.linkedin || '',
      website: record.website || previous.website || '',
      firstSeenAt: previous.firstSeenAt || metadata.firstSeenAt || nowIso(),
      lastVerifiedAt: metadata.verifiedAt || nowIso(),
      firstSeenMission: previous.firstSeenMission || metadata.missionId || null,
      lastMission: metadata.missionId || previous.lastMission || null,
      masterRow: metadata.rowsByKey?.[key] || previous.masterRow || null,
      status: 'verified',
      primaryRole: record.role || previous.primaryRole || '',
      primaryJobUrl: record.jobUrl || previous.primaryJobUrl || '',
      location: record.location || previous.location || '',
      workType: record.workType || previous.workType || '',
      employeeCount: record.employeeCount || previous.employeeCount || null,
      jobs,
    };
  }
  return saveState(state);
}

function setMasterSheet(sheet = {}) {
  const state = loadState();
  state.sheetUrl = sheet.url || sheet.sheetUrl || state.sheetUrl;
  state.spreadsheetId = sheet.spreadsheetId || state.spreadsheetId;
  state.sheetName = sheet.sheetName || state.sheetName || 'Leads';
  state.spreadsheetTitle = sheet.title || sheet.spreadsheetTitle || state.spreadsheetTitle;
  return saveState(state);
}

function masterSheetUrl() { return loadState().sheetUrl || null; }
function masterCount() { return Object.values(loadState().companies || {}).filter((item) => item.status === 'verified').length; }

function remainingForTarget(total) {
  const desired = Math.max(0, Number(total || 0));
  const current = masterCount();
  return { desired, current, remaining: Math.max(0, desired - current) };
}

function rowFor(record = {}, metadata = {}) {
  const key = companyKey(record);
  const state = loadState();
  const previous = state.companies[key] || {};
  const otherJobs = (previous.jobs || [])
    .filter((job) => job.jobUrl && job.jobUrl !== record.jobUrl)
    .map((job) => [job.role, job.jobUrl].filter(Boolean).join(' — '))
    .join('\n');
  return [
    record.company || '',
    normalizeLinkedIn(record.linkedin),
    record.website || '',
    record.role || '',
    record.jobUrl || '',
    record.location || '',
    metadata.state || '',
    record.workType || '',
    record.employeeCount?.label || record.employeeRange || '',
    record.hiringSignal || '',
    otherJobs,
    previous.firstSeenAt || metadata.firstSeenAt || nowIso(),
    metadata.verifiedAt || nowIso(),
    metadata.missionId || '',
    'VERIFIED',
    previous.contactName || '',
    previous.contactTitle || '',
    previous.contactLinkedin || '',
    previous.email || record.email || '',
    previous.phone || record.phone || '',
    previous.enrichmentStatus || '',
    previous.notes || '',
    previous.nextAction || '',
  ];
}

function contactUpdate(key, contact = {}) {
  const state = loadState();
  if (!state.companies[key]) return null;
  state.companies[key] = {
    ...state.companies[key],
    contactName: contact.name || state.companies[key].contactName || '',
    contactTitle: contact.title || state.companies[key].contactTitle || '',
    contactLinkedin: contact.linkedin || state.companies[key].contactLinkedin || '',
    email: contact.email || state.companies[key].email || '',
    phone: contact.phone || state.companies[key].phone || '',
    enrichmentStatus: contact.status || state.companies[key].enrichmentStatus || '',
  };
  saveState(state);
  return state.companies[key];
}

module.exports = {
  STATE_FILE,
  FINAL_MASTER_HEADERS,
  loadState,
  saveState,
  normalizeLinkedIn,
  normalizeName,
  hostname,
  companyKey,
  isCompanyRecord,
  hasSapOpening,
  qualifies,
  allowRepeatFromText,
  seen,
  filterUnseen,
  registerRecords,
  setMasterSheet,
  masterSheetUrl,
  masterCount,
  remainingForTarget,
  rowFor,
  contactUpdate,
};
