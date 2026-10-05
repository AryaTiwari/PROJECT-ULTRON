'use strict';

// Isolated LinkedIn URL enrichment for Google Sheets.
// This module deliberately does NOT import Apollo enrichment or modify the
// universal contact/POC enrichment operator. It only fills currently blank
// LinkedIn URL cells after deterministic LinkedIn-side verification.

const sheetsDefault = require('./google-sheets-operator');
const schemaTools = require('./universal-sheet-schema');
const linkedinMcpDefault = require('./linkedin-mcp-client');
const profileParser = require('./universal-linkedin-profile-parser');

function text(value) { return String(value ?? '').trim(); }

function normalizeLinkedInUrl(value, kind = null) {
  const raw = text(value);
  if (!raw) return '';
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate);
    if (!/^(?:www\.)?linkedin\.com$/i.test(url.hostname)) return '';
    const parts = url.pathname.split('/').filter(Boolean);
    if (kind === 'company' && String(parts[0] || '').toLowerCase() !== 'company') return '';
    if (kind === 'person' && String(parts[0] || '').toLowerCase() !== 'in') return '';
    if (!parts.length || (kind === 'company' && parts.length < 2) || (kind === 'person' && parts.length < 2)) return '';
    const prefix = String(parts[0]).toLowerCase();
    if (!['company', 'in'].includes(prefix)) return '';
    return `https://www.linkedin.com/${prefix}/${decodeURIComponent(parts[1]).trim()}/`;
  } catch {
    return '';
  }
}

function linkedInSlug(url, kind) {
  const normalized = normalizeLinkedInUrl(url, kind);
  if (!normalized) return '';
  try {
    return decodeURIComponent(new URL(normalized).pathname.split('/').filter(Boolean)[1] || '').trim();
  } catch {
    return '';
  }
}

function canonicalCompanyName(value) {
  return text(value)
    .split(/\r?\n/).map((part) => part.trim()).find(Boolean) || '';
}

function companyKey(value) {
  return canonicalCompanyName(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(?:private|pvt|limited|ltd|llp|inc|incorporated|corporation|corp|company|co)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function companyMatches(expected, actual) {
  const a = companyKey(expected);
  const b = companyKey(actual);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 5 && b.includes(a)) return true;
  if (b.length >= 5 && a.includes(b)) return true;
  const at = new Set(a.split(' ').filter((part) => part.length >= 2));
  const bt = new Set(b.split(' ').filter((part) => part.length >= 2));
  if (!at.size || !bt.size) return false;
  const overlap = [...at].filter((part) => bt.has(part)).length;
  return overlap / Math.max(at.size, bt.size) >= 0.75;
}

function nameKey(value) {
  return text(value)
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameMatchScore(expected, actual) {
  const a = nameKey(expected);
  const b = nameKey(actual);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const at = a.split(' ').filter(Boolean);
  const bt = b.split(' ').filter(Boolean);
  const bSet = new Set(bt);
  let matched = at.filter((token) => bSet.has(token)).length;
  for (const token of at) {
    if (token.length !== 1) continue;
    if (bt.some((candidate) => candidate.startsWith(token))) matched++;
  }
  const tokenScore = matched / Math.max(at.length, bt.length);
  const compactA = at.join('');
  const compactB = bt.join('');
  if (compactB.includes(compactA) || compactA.includes(compactB)) return Math.max(0.9, tokenScore);
  return Math.min(1, tokenScore);
}

function schemaField(group, field) {
  const index = group?.fields?.[field]?.index;
  return Number.isInteger(index) ? index : null;
}

function firstCompanyGroup(schema = {}) {
  return (schema.companyGroups || []).find((group) => (
    schemaField(group, 'company') != null ||
    schemaField(group, 'name') != null ||
    schemaField(group, 'linkedin') != null
  )) || null;
}

function personGroups(schema = {}) {
  return (schema.personGroups || [])
    .filter((group) => schemaField(group, 'name') != null || schemaField(group, 'linkedin') != null)
    .sort((a, b) => Number(a?.ordinal || 999) - Number(b?.ordinal || 999));
}

function linkedinColumns(schema = {}) {
  const columns = new Set();
  for (const group of [firstCompanyGroup(schema), ...personGroups(schema)]) {
    const index = schemaField(group, 'linkedin');
    if (index != null) columns.add(index);
  }
  return [...columns].sort((a, b) => a - b);
}

function collectLinkedInUrls(value, kind, out = new Set()) {
  if (value == null) return out;
  if (typeof value === 'string') {
    const regex = kind === 'company'
      ? /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/company\/[A-Za-z0-9%._~-]+\/?/gi
      : /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9%._~-]+\/?/gi;
    for (const match of value.matchAll(regex)) {
      const normalized = normalizeLinkedInUrl(match[0], kind);
      if (normalized) out.add(normalized);
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectLinkedInUrls(item, kind, out);
    return out;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) collectLinkedInUrls(item, kind, out);
  }
  return out;
}

function collectLinkedInRecords(value, kind, out = [], seen = new WeakSet(), depth = 0) {
  if (value == null || depth > 8) return out;
  if (typeof value === 'string') {
    for (const url of collectLinkedInUrls(value, kind)) out.push({ url, name: '', title: '' });
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectLinkedInRecords(item, kind, out, seen, depth + 1);
    return out;
  }
  if (typeof value !== 'object') return out;
  if (seen.has(value)) return out;
  seen.add(value);

  const url = [...collectLinkedInUrls(value, kind)][0] || '';
  if (url) {
    const name = text(
      value.name ||
      value.full_name ||
      value.fullName ||
      value.company_name ||
      value.companyName ||
      value.organization_name ||
      value.organizationName ||
      ([value.first_name, value.last_name].filter(Boolean).join(' ')),
    );
    const title = text(value.title || value.headline || value.job_title || value.jobTitle);
    out.push({ url, name, title });
  }

  for (const item of Object.values(value)) collectLinkedInRecords(item, kind, out, seen, depth + 1);
  return out;
}

function uniqueRecords(records = [], kind) {
  const map = new Map();
  for (const record of records) {
    const url = normalizeLinkedInUrl(record?.url, kind);
    if (!url) continue;
    const key = url.toLowerCase();
    if (!map.has(key) || (record?.name && !map.get(key).name)) {
      map.set(key, { ...record, url });
    }
  }
  return [...map.values()];
}

function companyProfileName(profile) {
  const direct = [
    profile?.name,
    profile?.company_name,
    profile?.companyName,
    profile?.organization_name,
    profile?.organizationName,
    profile?.title,
    profile?.sections?.main_profile?.name,
    profile?.sections?.about?.name,
  ];
  for (const candidate of direct) {
    if (text(candidate)) return text(candidate);
  }
  return '';
}

function personProfileName(profile) {
  const direct = [
    profile?.name,
    profile?.full_name,
    profile?.fullName,
    profile?.profile?.name,
    profile?.sections?.main_profile?.name,
    profile?.sections?.main_profile?.full_name,
    profile?.sections?.about?.name,
    [profile?.first_name, profile?.last_name].filter(Boolean).join(' '),
  ];
  for (const candidate of direct) {
    if (text(candidate)) return text(candidate);
  }
  return '';
}

function companyUrns(value, out = new Set()) {
  if (value == null) return out;
  if (Array.isArray(value)) {
    for (const item of value) companyUrns(item, out);
    return out;
  }
  if (typeof value !== 'object') return out;
  if (text(value.kind).toLowerCase() === 'company_urn' && /^\d+$/.test(text(value.value))) {
    out.add(text(value.value));
  }
  for (const item of Object.values(value)) companyUrns(item, out);
  return out;
}

function dataRows(source, rowLimit) {
  const headerRow = Number(source?.schema?.headerRowNumber || source?.schema?.headerRowIndex + 1 || 1);
  const rows = Array.isArray(source?.rows) ? source.rows : [];
  const limit = Number(rowLimit || 0);
  const output = [];
  let dataCount = 0;
  for (let rowIndex = headerRow; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex] || [];
    if (!row.some((value) => text(value))) continue;
    dataCount++;
    if (limit > 0 && dataCount > limit) break;
    output.push({ rowNumber: rowIndex + 1, row });
  }
  return output;
}

function missingLinkTargets(source, rowLimit) {
  const schema = source?.schema || {};
  const companyGroup = firstCompanyGroup(schema);
  const pGroups = personGroups(schema);
  const targets = [];
  for (const { rowNumber, row } of dataRows(source, rowLimit)) {
    const companyNameColumn = schemaField(companyGroup, 'company') ?? schemaField(companyGroup, 'name');
    const companyLinkColumn = schemaField(companyGroup, 'linkedin');
    if (companyNameColumn != null && companyLinkColumn != null && text(row[companyNameColumn]) && !text(row[companyLinkColumn])) {
      targets.push({ type: 'company', rowNumber, columnIndex: companyLinkColumn, companyName: canonicalCompanyName(row[companyNameColumn]) });
    }
    for (const group of pGroups) {
      const nameColumn = schemaField(group, 'name');
      const linkColumn = schemaField(group, 'linkedin');
      if (nameColumn == null || linkColumn == null) continue;
      const name = text(row[nameColumn]);
      if (!name || text(row[linkColumn])) continue;
      const role = text(row[schemaField(group, 'role') ?? -1]);
      targets.push({
        type: 'person',
        ordinal: Number(group.ordinal || 0) || null,
        groupId: group.id,
        rowNumber,
        columnIndex: linkColumn,
        name,
        role,
      });
    }
  }
  return targets;
}

async function hydrateRichLinks(source, api = sheetsDefault) {
  const schema = source?.schema || {};
  for (const columnIndex of linkedinColumns(schema)) {
    if (typeof api.linkedInHyperlinks !== 'function') continue;
    const links = await api.linkedInHyperlinks(
      source.spreadsheetId,
      source.sheetName,
      columnIndex,
      Math.max(source.rows?.length || 0, Number(schema.headerRowNumber || 1)),
    );
    for (const [rowNumber, link] of links.entries()) {
      const rowIndex = rowNumber - 1;
      if (!source.rows[rowIndex]) source.rows[rowIndex] = [];
      source.rows[rowIndex][columnIndex] = link;
    }
  }
  return source;
}

async function safeWriteChanges(source, changes, api = sheetsDefault) {
  if (!changes.length || typeof api.batchValues !== 'function' || typeof api.writeCells !== 'function') return { written: 0, conflicts: 0 };
  const ranges = changes.map((change) => change.range);
  const live = await api.batchValues(source.spreadsheetId, ranges, { formulas: false });
  const safe = [];
  let conflicts = 0;
  for (let i = 0; i < changes.length; i++) {
    const liveValue = text(live[i]?.[0]?.[0]);
    if (liveValue) {
      conflicts++;
      continue;
    }
    safe.push(changes[i]);
  }
  if (!safe.length) return { written: 0, conflicts };
  const result = await api.writeCells(source.spreadsheetId, safe);
  return { written: Number(result?.updatedCells || safe.length), conflicts };
}

function companySlugFromUrl(url) {
  return linkedInSlug(url, 'company');
}

function personSlugFromUrl(url) {
  return linkedInSlug(url, 'person');
}

async function getVerifiedCompanyContext(companyName, existingUrl, stats, linkedin) {
  const expected = canonicalCompanyName(companyName);
  if (!expected) return null;

  const candidateSlugs = [];
  const existingSlug = companySlugFromUrl(existingUrl);
  if (existingSlug) candidateSlugs.push(existingSlug);

  const searchCompany = async () => {
    stats.companySearches++;
    return linkedin.callTool('search_companies', { keywords: expected });
  };

  let searchPayload = null;
  if (!existingSlug) {
    try {
      searchPayload = await searchCompany();
    } catch (error) {
      stats.providerFailures++;
      return null;
    }
  }

  const records = uniqueRecords(
    [
      ...collectLinkedInRecords(searchPayload, 'company'),
      ...candidateSlugs.map((slug) => ({ url: `https://www.linkedin.com/company/${encodeURIComponent(slug)}/`, name: expected })),
    ],
    'company',
  );

  if (!records.length && !existingSlug) {
    const derived = companyKey(expected).replace(/ /g, '-');
    if (derived) records.push({ url: `https://www.linkedin.com/company/${derived}/`, name: expected });
  }

  for (const record of records.slice(0, 5)) {
    const slug = companySlugFromUrl(record.url);
    if (!slug) continue;
    try {
      stats.companyProfileFetches++;
      const profile = await linkedin.callTool('get_company_profile', { company_name: slug });
      const profileName = companyProfileName(profile);
      if (!companyMatches(expected, profileName)) continue;
      const urn = [...companyUrns(profile)][0] || '';
      return {
        companyName: expected,
        linkedinUrl: record.url,
        slug,
        urn,
        verified: true,
        profileName,
      };
    } catch {
      stats.providerFailures++;
    }
  }
  return null;
}

function personSearchQueries(name, role, companyName) {
  const variants = new Set();
  const base = text(name);
  if (!base) return [];
  if (role) variants.add(`${base} ${role}`);
  variants.add(base);
  if (companyName) variants.add(`${base} ${companyName}`);
  return [...variants].slice(0, 3);
}

async function getVerifiedPerson(name, role, companyContext, location, stats, linkedin) {
  const expectedName = text(name);
  if (!expectedName) return null;

  const urls = [];
  const addSearch = async (keywords, currentCompany = '') => {
    stats.personSearches++;
    const args = { keywords };
    if (currentCompany) args.current_company = currentCompany;
    if (location) args.location = location;
    try {
      const payload = await linkedin.callTool('search_people', args);
      const records = uniqueRecords(collectLinkedInRecords(payload, 'person'), 'person');
      for (const record of records) {
        if (!urls.some((item) => item.url.toLowerCase() === record.url.toLowerCase())) urls.push(record);
      }
    } catch {
      stats.providerFailures++;
    }
  };

  for (const query of personSearchQueries(expectedName, role, companyContext?.companyName || '')) {
    if (urls.length >= 8) break;
    await addSearch(query, companyContext?.urn || '');
    if (companyContext?.urn && urls.length) break;
  }

  const verified = [];
  for (const record of urls.slice(0, 6)) {
    const slug = personSlugFromUrl(record.url);
    if (!slug) continue;
    try {
      stats.personProfileFetches++;
      const profile = await linkedin.callTool('get_person_profile', {
        linkedin_username: slug,
        sections: 'experience',
        max_scrolls: 3,
      });
      const profileName = personProfileName(profile);
      const nameScore = nameMatchScore(expectedName, profileName || record.name);
      if (nameScore < 0.8) continue;

      let employerVerified = true;
      let employerName = '';
      if (companyContext?.companyName) {
        const employer = profileParser.resolveCurrentEmployer(profile);
        employerName = text(employer?.company);
        employerVerified = Boolean(employer?.resolved && employerName && companyMatches(companyContext.companyName, employerName));
      }
      if (!employerVerified) continue;

      verified.push({
        url: record.url,
        profileName: profileName || record.name,
        title: record.title,
        nameScore,
        employerName,
        employerVerified,
      });
    } catch {
      stats.providerFailures++;
    }
  }

  verified.sort((a, b) => b.nameScore - a.nameScore || a.url.localeCompare(b.url));
  if (!verified.length) return null;

  // Without company context, do not pick between duplicate same-name profiles.
  if (!companyContext?.companyName) {
    const top = verified[0];
    const ties = verified.filter((item) => item.nameScore === top.nameScore);
    if (top.nameScore < 1 || ties.length !== 1) return null;
  }

  return verified[0];
}

function plan(source, rowLimit) {
  const targets = missingLinkTargets(source, rowLimit);
  return {
    activated: targets.length > 0,
    targetCount: targets.length,
    companyTargets: targets.filter((target) => target.type === 'company').length,
    personTargets: targets.filter((target) => target.type === 'person').length,
    targets,
  };
}

async function run(source, options = {}) {
  if (!source?.spreadsheetId || !source?.sheetName || !source?.schema || !Array.isArray(source?.rows)) {
    throw Object.assign(new Error('LinkedIn link enricher requires an inspected worksheet source.'), {
      code: 'LINKEDIN_LINK_ENRICHER_SOURCE_REQUIRED',
      subsystem: 'LINKEDIN',
      errorType: 'CONFIG',
    });
  }

  const sheets = options.sheetsApi || sheetsDefault;
  const linkedin = options.linkedinMcp || linkedinMcpDefault;
  const rowLimit = options.rowLimit;
  await hydrateRichLinks(source, sheets);
  const activation = plan(source, rowLimit);
  const stats = {
    rowsScanned: dataRows(source, rowLimit).length,
    activated: activation.activated,
    targetCount: activation.targetCount,
    companyTargets: activation.companyTargets,
    personTargets: activation.personTargets,
    companySearches: 0,
    companyProfileFetches: 0,
    personSearches: 0,
    personProfileFetches: 0,
    companyLinksFilled: 0,
    personLinksFilled: 0,
    providerFailures: 0,
    liveConflicts: 0,
    writesAttempted: 0,
    linkedinProviderCalls: 0,
  };

  if (!activation.activated) {
    return { ok: true, activated: false, noOp: true, stats, plan: activation };
  }

  const companyGroup = firstCompanyGroup(source.schema);
  const companyNameColumn = schemaField(companyGroup, 'company') ?? schemaField(companyGroup, 'name');
  const companyLinkColumn = schemaField(companyGroup, 'linkedin');
  const pGroups = personGroups(source.schema);
  const companyContexts = new Map();
  const companyChanges = [];

  for (const target of activation.targets.filter((item) => item.type === 'company')) {
    const key = `row:${target.rowNumber}`;
    if (companyContexts.has(key)) continue;
    const existingUrl = companyLinkColumn != null ? text(source.rows[target.rowNumber - 1]?.[companyLinkColumn]) : '';
    const context = await getVerifiedCompanyContext(target.companyName, existingUrl, stats, linkedin);
    if (context) {
      companyContexts.set(key, context);
      if (!existingUrl) {
        companyChanges.push({
          range: sheets.cellRange(source.sheetName, target.rowNumber, target.columnIndex),
          value: context.linkedinUrl,
          source: 'linkedin-link-enricher:verified-company',
          evidence: { confidence: 0.98, source: 'fastmcp:get_company_profile' },
        });
      }
    }
  }

  stats.writesAttempted += companyChanges.length;
  const companyWrite = await safeWriteChanges(source, companyChanges, sheets);
  stats.companyLinksFilled += companyWrite.written;
  stats.liveConflicts += companyWrite.conflicts;

  const personChanges = [];
  for (const target of activation.targets.filter((item) => item.type === 'person')) {
    const row = source.rows[target.rowNumber - 1] || [];
    const companyName = companyNameColumn != null ? canonicalCompanyName(row[companyNameColumn]) : '';
    const existingCompanyLink = companyLinkColumn != null ? text(row[companyLinkColumn]) : '';
    const contextKey = `row:${target.rowNumber}`;
    let companyContext = companyContexts.get(contextKey) || null;

    if (!companyContext && companyName) {
      companyContext = await getVerifiedCompanyContext(companyName, existingCompanyLink, stats, linkedin);
      if (companyContext) companyContexts.set(contextKey, companyContext);
    }

    // If the company link was just written, keep that verified context in memory.
    const locationColumn = (companyGroup?.fields?.location?.index);
    const location = locationColumn != null ? text(row[locationColumn]) : '';
    const verifiedPerson = await getVerifiedPerson(
      target.name,
      target.role,
      companyContext,
      location,
      stats,
      linkedin,
    );
    if (!verifiedPerson) continue;

    personChanges.push({
      range: sheets.cellRange(source.sheetName, target.rowNumber, target.columnIndex),
      value: verifiedPerson.url,
      source: 'linkedin-link-enricher:verified-person',
      evidence: {
        confidence: verifiedPerson.nameScore,
        source: 'fastmcp:get_person_profile',
        profileName: verifiedPerson.profileName,
        employerName: verifiedPerson.employerName,
        employerVerified: verifiedPerson.employerVerified,
        pocOrdinal: target.ordinal,
      },
    });
  }

  stats.writesAttempted += personChanges.length;
  const personWrite = await safeWriteChanges(source, personChanges, sheets);
  stats.personLinksFilled += personWrite.written;
  stats.liveConflicts += personWrite.conflicts;

  return {
    ok: true,
    activated: true,
    noOp: false,
    stats,
    plan: activation,
    writes: {
      company: companyChanges.length,
      person: personChanges.length,
      companyWritten: companyWrite.written,
      personWritten: personWrite.written,
    },
  };
}

module.exports = {
  normalizeLinkedInUrl,
  linkedInSlug,
  canonicalCompanyName,
  companyKey,
  companyMatches,
  nameMatchScore,
  schemaField,
  firstCompanyGroup,
  personGroups,
  linkedinColumns,
  collectLinkedInUrls,
  collectLinkedInRecords,
  uniqueRecords,
  dataRows,
  missingLinkTargets,
  hydrateRichLinks,
  plan,
  run,
};
