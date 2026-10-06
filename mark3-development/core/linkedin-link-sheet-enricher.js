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

function normalizeLinkedInReferenceUrl(value, kind = null) {
  const raw = text(value);
  if (!raw) return '';
  const absolute = normalizeLinkedInUrl(raw, kind);
  if (absolute) return absolute;
  // MCP search references commonly expose canonical LinkedIn paths only.
  if (!raw.startsWith('/')) return '';
  return normalizeLinkedInUrl(`https://www.linkedin.com${raw}`, kind);
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
    const normalizedAnchors = new Set();
    // Some MCP releases return search results as readable Markdown instead of
    // structured `references` objects. Preserve the anchor label as the result
    // identity; treating every URL in rawText as nameless made all such results
    // fail the company-name check after spending a successful search call.
    const anchorPattern = /\[([^\]]{1,200})\]\((https?:\/\/(?:www\.)?linkedin\.com\/(?:company|in)\/[^\s)]+)\)/gi;
    for (const match of value.matchAll(anchorPattern)) {
      const url = normalizeLinkedInUrl(match[2], kind);
      if (!url) continue;
      const name = text(match[1].replace(/[`*_]/g, '').replace(/^\s*(?:\d+[.)]|[-*])\s*/, ''));
      out.push({ url, name, title: '', ...(kind === 'company' ? { kind: 'company' } : {}) });
      normalizedAnchors.add(url.toLowerCase());
    }
    for (const url of collectLinkedInUrls(value, kind)) {
      if (!normalizedAnchors.has(url.toLowerCase())) out.push({ url, name: '', title: '' });
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectLinkedInRecords(item, kind, out, seen, depth + 1);
    return out;
  }
  if (typeof value !== 'object') return out;
  if (seen.has(value)) return out;
  seen.add(value);

  const referenceKind = text(value.kind).toLowerCase();
  const expectedReferenceKind = kind === 'company' ? 'company' : 'person';
  const referenceUrl = (!referenceKind || referenceKind === expectedReferenceKind)
    ? normalizeLinkedInReferenceUrl(value.url || value.uri || value.href, kind)
    : '';
  const url = referenceUrl || [...collectLinkedInUrls(value, kind)][0] || '';
  if (url) {
    const name = text(
      value.name ||
      value.full_name ||
      value.fullName ||
      value.company_name ||
      value.companyName ||
      value.organization_name ||
      value.organizationName ||
      // The production LinkedIn MCP returns search-result identities as
      // references with { kind, url, text }, rather than `companies` objects.
      value.text ||
      ([value.first_name, value.last_name].filter(Boolean).join(' ')),
    );
    const title = text(value.title || value.headline || value.job_title || value.jobTitle);
    out.push({ url, name, title, kind: text(value.kind) });
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
    if (companyNameColumn != null && companyLinkColumn != null && text(row[companyNameColumn]) && !normalizeLinkedInUrl(row[companyLinkColumn], 'company')) {
      targets.push({ type: 'company', linkKind: 'company', rowNumber, columnIndex: companyLinkColumn, companyName: canonicalCompanyName(row[companyNameColumn]) });
    }
    for (const group of pGroups) {
      const nameColumn = schemaField(group, 'name');
      const linkColumn = schemaField(group, 'linkedin');
      if (nameColumn == null || linkColumn == null) continue;
      const name = text(row[nameColumn]);
      if (!name || normalizeLinkedInUrl(row[linkColumn], 'person')) continue;
      const role = text(row[schemaField(group, 'role') ?? -1]);
      targets.push({
        type: 'person',
        linkKind: 'person',
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
    if (normalizeLinkedInUrl(liveValue, changes[i].linkKind || null)) {
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
      recordProviderFailure(error, stats);
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
  stats.companySearchRecords = Number(stats.companySearchRecords || 0) + records.length;

  // LinkedIn's company search already returns an identity-labeled canonical
  // company URL. When there is exactly one result whose normalized legal name
  // matches the requested company, a second profile fetch adds no identity
  // evidence and consumes another protected account call. Use the exact search
  // result directly; retain profile verification for aliases and ambiguity.
  const exactMatches = records.filter((record) => (
    (!record.kind || record.kind === 'company')
    && record.name
    && companyKey(record.name) === companyKey(expected)
  ));
  stats.companyExactSearchCandidates = Number(stats.companyExactSearchCandidates || 0) + exactMatches.length;
  if (exactMatches.length === 1) {
    const record = exactMatches[0];
    const slug = companySlugFromUrl(record.url);
    if (slug) {
      stats.companyExactSearchMatches = Number(stats.companyExactSearchMatches || 0) + 1;
      return {
        companyName: expected,
        linkedinUrl: record.url,
        slug,
        urn: '',
        verified: true,
        verificationMethod: 'unique-exact-company-search-result',
        profileName: record.name,
      };
    }
  }

  if (exactMatches.length > 1) {
    stats.companyAmbiguousExactSearches = Number(stats.companyAmbiguousExactSearches || 0) + 1;
  }
  // Keep each company lookup bounded: try the strongest exact-name candidate
  // first (or the best name-compatible result if there is no exact match), and
  // never fan one search out into five profile calls. Ambiguous exact results
  // require an explicit matching name from the profile before any URL is used.
  const verificationCandidates = exactMatches.length
    ? exactMatches.slice(0, 1)
    : records.filter((record) => (!record.kind || record.kind === 'company') && companyMatches(expected, record.name)).slice(0, 1);
  if (!verificationCandidates.length) {
    stats.companyNoNameMatchedCandidates = Number(stats.companyNoNameMatchedCandidates || 0) + 1;
    return null;
  }
  for (const record of verificationCandidates) {
    const slug = companySlugFromUrl(record.url);
    if (!slug) continue;
    try {
      stats.companyProfileFetches++;
      const profile = await linkedin.callTool('get_company_profile', { company_name: slug });
      const profileName = companyProfileName(profile);
      // The production MCP profile response contains { url, sections, ... }
      // and usually has no top-level company name. A matching company search
      // reference plus a successful fetch of its exact slug verifies identity.
      if (profileName && !companyMatches(expected, profileName)) {
        stats.companyProfileNameMismatches = Number(stats.companyProfileNameMismatches || 0) + 1;
        continue;
      }
      if (exactMatches.length > 1 && !profileName) {
        stats.companyAmbiguousProfilesWithoutName = Number(stats.companyAmbiguousProfilesWithoutName || 0) + 1;
        continue;
      }
      const urn = [...companyUrns(profile)][0] || '';
      return {
        companyName: expected,
        linkedinUrl: record.url,
        slug,
        urn,
        verified: true,
        profileName,
      };
    } catch (error) {
      stats.companyProfileCheckFailures = Number(stats.companyProfileCheckFailures || 0) + 1;
      recordProviderFailure(error, stats);
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
    } catch (error) {
      recordProviderFailure(error, stats);
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
    } catch (error) {
      recordProviderFailure(error, stats);
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

function numericOption(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function recordProviderFailure(error, stats) {
  stats.providerFailures++;
  const failure = {
    code: String(error?.code || 'LINKEDIN_PROVIDER_ERROR'),
    message: text(error?.message || error || 'LinkedIn provider request failed').slice(0, 240),
    nextEligibleAt: text(error?.cooldownUntil || error?.nextEligibleAt) || null,
  };
  stats.providerErrors ||= [];
  if (!stats.providerErrors.some((item) => item.code === failure.code && item.message === failure.message)) {
    stats.providerErrors.push(failure);
  }
  if (/^LINKEDIN_(?:BURST|HOURLY|DAILY)_CAP$|^LINKEDIN_COOLDOWN_ACTIVE$|^LINKEDIN_MANUAL_LOCK$/.test(failure.code)) {
    stats.providerStop ||= failure;
  }
}

async function withTimeout(promise, timeoutMs, label) {
  const ms = numericOption(timeoutMs, 25000, 1000, 120000);
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`${label} timed out after ${ms}ms.`);
          error.code = 'LINKEDIN_LINK_PROVIDER_TIMEOUT';
          reject(error);
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function mapWithConcurrency(items, concurrency, worker) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return [];
  const limit = Math.max(1, Math.min(list.length, numericOption(concurrency, 4, 1, 8)));
  const results = new Array(list.length);
  let next = 0;

  async function runner() {
    while (true) {
      const index = next++;
      if (index >= list.length) return;
      try {
        results[index] = { status: 'fulfilled', value: await worker(list[index], index) };
      } catch (error) {
        results[index] = { status: 'rejected', reason: error };
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, () => runner()));
  return results;
}

async function hydrateRichLinks(source, api = sheetsDefault, options = {}) {
  const schema = source?.schema || {};
  const columns = linkedinColumns(schema);
  if (typeof api.linkedInHyperlinks !== 'function' || !columns.length) return source;

  const timeoutMs = numericOption(
    options.richLinkTimeoutMs ?? process.env.ULTRON_M3_LINK_RICH_METADATA_TIMEOUT_MS,
    5000,
    1000,
    30000,
  );
  const results = await mapWithConcurrency(columns, Math.min(columns.length, 3), async (columnIndex) => (
    withTimeout(
      api.linkedInHyperlinks(
        source.spreadsheetId,
        source.sheetName,
        columnIndex,
        Math.max(source.rows?.length || 0, Number(schema.headerRowNumber || 1)),
      ),
      timeoutMs,
      `Rich LinkedIn metadata read for column ${columnIndex}`,
    )
  ));

  for (let i = 0; i < results.length; i++) {
    const outcome = results[i];
    if (outcome.status !== 'fulfilled') continue;
    for (const [rowNumber, link] of outcome.value.entries()) {
      const rowIndex = rowNumber - 1;
      if (!source.rows[rowIndex]) source.rows[rowIndex] = [];
      source.rows[rowIndex][columns[i]] = link;
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
    if (normalizeLinkedInUrl(liveValue, changes[i].linkKind || null)) {
      conflicts++;
      continue;
    }
    safe.push(changes[i]);
  }
  if (!safe.length) return { written: 0, conflicts };
  const result = await api.writeCells(source.spreadsheetId, safe);
  return { written: Number(result?.updatedCells || safe.length), conflicts };
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
  const concurrency = numericOption(
    options.concurrency ?? process.env.ULTRON_M3_LINK_ENRICHMENT_CONCURRENCY,
    4,
    1,
    8,
  );
  const providerTimeoutMs = numericOption(
    options.providerTimeoutMs ?? process.env.ULTRON_M3_LINK_ENRICHMENT_PROVIDER_TIMEOUT_MS,
    25000,
    3000,
    120000,
  );

  // Do rich-link hydration as a bounded best-effort operation. It must never
  // block discovery for minutes, because the normal Values API already gives us
  // the visible cell contents and safeWriteChanges re-checks the live cell before
  // every actual mutation.
  await hydrateRichLinks(source, sheets, { richLinkTimeoutMs: options.richLinkTimeoutMs });

  const activation = plan(source, rowLimit);
  const stats = {
    rowsScanned: dataRows(source, rowLimit).length,
    activated: activation.activated,
    targetCount: activation.targetCount,
    companyTargets: activation.companyTargets,
    personTargets: activation.personTargets,
    companySearches: 0,
    companyProfileFetches: 0,
    companyExactSearchMatches: 0,
    companySearchRecords: 0,
    companyExactSearchCandidates: 0,
    companyAmbiguousExactSearches: 0,
    companyNoNameMatchedCandidates: 0,
    companyProfileNameMismatches: 0,
    companyAmbiguousProfilesWithoutName: 0,
    companyProfileCheckFailures: 0,
    personSearches: 0,
    personProfileFetches: 0,
    companyLinksFilled: 0,
    personLinksFilled: 0,
    providerFailures: 0,
    providerErrors: [],
    providerStop: null,
    providerTimeouts: 0,
    liveConflicts: 0,
    writesAttempted: 0,
    linkedinProviderCalls: 0,
    linkedinProviderCallsSucceeded: 0,
    companyUnresolvedRows: [],
    personUnresolvedRows: [],
    alreadyPopulatedSkipped: 0,
  };
  let providerQueue = Promise.resolve();
  const trackedLinkedIn = {
    callTool(tool, args) {
      const call = providerQueue.then(async () => {
        if (stats.providerStop) {
          const stopped = new Error(stats.providerStop.message);
          stopped.code = stats.providerStop.code;
          throw stopped;
        }
        stats.linkedinProviderCalls++;
        try {
          const value = await linkedin.callTool(tool, args);
          stats.linkedinProviderCallsSucceeded++;
          return value;
        } catch (error) {
          if (/^LINKEDIN_(?:BURST|HOURLY|DAILY)_CAP$|^LINKEDIN_COOLDOWN_ACTIVE$|^LINKEDIN_MANUAL_LOCK$/.test(String(error?.code || ''))) {
            stats.providerStop ||= {
              code: String(error.code),
              message: text(error.message).slice(0, 240),
              nextEligibleAt: text(error.cooldownUntil || error.nextEligibleAt) || null,
            };
          }
          throw error;
        }
      });
      providerQueue = call.catch(() => {});
      return call;
    },
  };

  if (!activation.activated) {
    return { ok: true, activated: false, noOp: true, stats, plan: activation };
  }

  const companyGroup = firstCompanyGroup(source.schema);
  const companyNameColumn = schemaField(companyGroup, 'company') ?? schemaField(companyGroup, 'name');
  const companyLinkColumn = schemaField(companyGroup, 'linkedin');
  const pGroups = personGroups(source.schema);
  const companyContexts = new Map();
  const companyPromiseCache = new Map();

  async function verifyCompanyForTarget(target) {
    const row = source.rows[target.rowNumber - 1] || [];
    const existingUrl = companyLinkColumn != null ? text(row[companyLinkColumn]) : '';
    if (normalizeLinkedInUrl(existingUrl, 'company')) {
      stats.alreadyPopulatedSkipped++;
      return { context: null, change: null };
    }

    const cacheKey = companyKey(target.companyName);
    let promise = companyPromiseCache.get(cacheKey);
    if (!promise) {
      promise = withTimeout(
        getVerifiedCompanyContext(target.companyName, '', stats, trackedLinkedIn),
        providerTimeoutMs,
        `Company LinkedIn enrichment for "${target.companyName}"`,
      ).catch((error) => {
        if (error?.code === 'LINKEDIN_LINK_PROVIDER_TIMEOUT') stats.providerTimeouts++;
        return null;
      });
      companyPromiseCache.set(cacheKey, promise);
    }

    const context = await promise;
    if (!context) {
      stats.companyUnresolvedRows.push(target.rowNumber);
      return { context: null, change: null };
    }

    companyContexts.set(`row:${target.rowNumber}`, context);
    return {
      context,
      change: {
        range: sheets.cellRange(source.sheetName, target.rowNumber, target.columnIndex),
        value: context.linkedinUrl,
        source: 'linkedin-link-enricher:verified-company',
        linkKind: 'company',
        evidence: {
          confidence: context.verificationMethod === 'unique-exact-company-search-result' ? 0.96 : 0.98,
          source: context.verificationMethod === 'unique-exact-company-search-result'
            ? 'fastmcp:search_companies:unique-exact-name'
            : 'fastmcp:get_company_profile',
        },
      },
    };
  }

  async function commitVerifiedChange(change, type) {
    if (!change) return;
    stats.writesAttempted++;
    const write = await safeWriteChanges(source, [change], sheets);
    stats.liveConflicts += write.conflicts;
    if (write.written) {
      if (type === 'company') stats.companyLinksFilled += write.written;
      else stats.personLinksFilled += write.written;

      const match = change.range.match(/!([A-Z]+)(\d+)$/i);
      if (match) {
        const rowNumber = Number(match[2]);
        const index = (() => {
          let n = 0;
          for (const ch of match[1].toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
          return n - 1;
        })();
        if (source.rows[rowNumber - 1]) source.rows[rowNumber - 1][index] = change.value;
      }
    }
  }

  // Company lookups run concurrently and each verified result is written
  // immediately. A single slow company can no longer hold every earlier result
  // hostage.
  const companyTargets = activation.targets.filter((item) => item.type === 'company');
  await mapWithConcurrency(companyTargets, concurrency, async (target) => {
    const result = await verifyCompanyForTarget(target);
    if (result.change) await commitVerifiedChange(result.change, 'company');
    return result;
  });

  const locationColumn = companyGroup?.fields?.location?.index;
  const personTargets = activation.targets.filter((item) => item.type === 'person');

  // POC verification also runs concurrently. Each successful profile is written
  // immediately after the exact person+employer check passes.
  await mapWithConcurrency(personTargets, concurrency, async (target) => {
    const row = source.rows[target.rowNumber - 1] || [];
    const companyName = companyNameColumn != null ? canonicalCompanyName(row[companyNameColumn]) : '';
    const existingCompanyLink = companyLinkColumn != null ? text(row[companyLinkColumn]) : '';
    const contextKey = `row:${target.rowNumber}`;
    let companyContext = companyContexts.get(contextKey) || null;

    if (!companyContext && companyName) {
      const cacheKey = companyKey(companyName);
      let promise = companyPromiseCache.get(cacheKey);
      if (!promise) {
        promise = withTimeout(
          getVerifiedCompanyContext(companyName, existingCompanyLink, stats, trackedLinkedIn),
          providerTimeoutMs,
          `Company LinkedIn context for "${companyName}"`,
        ).catch((error) => {
          if (error?.code === 'LINKEDIN_LINK_PROVIDER_TIMEOUT') stats.providerTimeouts++;
          return null;
        });
        companyPromiseCache.set(cacheKey, promise);
      }
      companyContext = await promise;
      if (companyContext) companyContexts.set(contextKey, companyContext);
    }

    const location = locationColumn != null ? text(row[locationColumn]) : '';
    const verifiedPerson = await withTimeout(
      getVerifiedPerson(target.name, target.role, companyContext, location, stats, trackedLinkedIn),
      providerTimeoutMs,
      `POC LinkedIn enrichment for "${target.name}"`,
    ).catch((error) => {
      if (error?.code === 'LINKEDIN_LINK_PROVIDER_TIMEOUT') stats.providerTimeouts++;
      return null;
    });

    if (!verifiedPerson) {
      stats.personUnresolvedRows.push(target.rowNumber);
      return null;
    }

    await commitVerifiedChange({
      range: sheets.cellRange(source.sheetName, target.rowNumber, target.columnIndex),
      value: verifiedPerson.url,
      source: 'linkedin-link-enricher:verified-person',
      linkKind: 'person',
      evidence: {
        confidence: verifiedPerson.nameScore,
        source: 'fastmcp:get_person_profile',
        profileName: verifiedPerson.profileName,
        employerName: verifiedPerson.employerName,
        employerVerified: verifiedPerson.employerVerified,
        pocOrdinal: target.ordinal,
      },
    }, 'person');
    return verifiedPerson;
  });

  return {
    ok: true,
    activated: true,
    noOp: false,
    stats,
    plan: activation,
    writes: {
      company: stats.companyLinksFilled,
      person: stats.personLinksFilled,
      companyWritten: stats.companyLinksFilled,
      personWritten: stats.personLinksFilled,
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
