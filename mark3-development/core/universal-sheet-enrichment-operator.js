'use strict';

const sheets = require('./google-sheets-operator');
const apollo = require('./apollo-enrichment');
const linkedinMcp = require('./linkedin-mcp-client');
const schemaTools = require('./universal-sheet-schema');
const planner = require('./universal-enrichment-planner');
const ranker = require('./universal-authority-ranker');
const profileParser = require('./universal-linkedin-profile-parser');

function text(value) { return String(value ?? '').trim(); }
function integer(value, fallback, min = 1, max = 500) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
}
function linkedinSlug(value) {
  const normalized = apollo.normalizeLinkedIn(value);
  if (!normalized) return '';
  try { return decodeURIComponent(new URL(normalized).pathname.match(/^\/in\/([^/]+)/i)?.[1] || '').trim(); } catch { return ''; }
}
function websiteDomain(value) { return ranker.hostname(value); }

function schemaLinkedInColumns(schema) {
  const indexes = new Set();
  for (const column of schema.columns || []) {
    if (/^linkedin(?:_|$)/.test(column.role) || /\blinkedin\b/i.test(column.header || '')) indexes.add(column.index);
  }
  return [...indexes].sort((a, b) => a - b);
}

async function patchRichLinkedInLinks(spreadsheetId, sheetName, rows, schema) {
  for (const columnIndex of schemaLinkedInColumns(schema)) {
    const links = await sheets.linkedInHyperlinks(spreadsheetId, sheetName, columnIndex, Math.max(rows.length, schema.headerRowNumber));
    for (const [rowNumber, link] of links.entries()) {
      const rowIndex = rowNumber - 1;
      if (!rows[rowIndex]) rows[rowIndex] = [];
      rows[rowIndex][columnIndex] = link;
    }
  }
  return rows;
}

async function readUniversalSheet(sheetUrl, options = {}) {
  const spreadsheetId = sheets.spreadsheetId(sheetUrl);
  const meta = await sheets.metadata(spreadsheetId);
  const requestedName = text(options.sheetName);
  const tabs = (meta.sheets || []).map((sheet) => ({
    name: sheet?.properties?.title,
    sheetId: sheet?.properties?.sheetId,
  })).filter((sheet) => sheet.name);
  const targetTabs = requestedName ? tabs.filter((tab) => tab.name === requestedName) : tabs;
  if (!targetTabs.length) {
    const error = new Error(requestedName ? `Google Sheet tab not found: ${requestedName}` : 'Spreadsheet has no readable tabs.');
    error.code = 'UNIVERSAL_SHEET_TAB_NOT_FOUND';
    throw error;
  }

  let best = null;
  for (const tab of targetTabs) {
    const rows = await sheets.values(spreadsheetId, `${sheets.quoteSheet(tab.name)}!A:ZZ`);
    let schema;
    try { schema = schemaTools.inferSchema(rows, options.schema || {}); } catch (error) {
      if (requestedName) throw error;
      continue;
    }
    const candidate = { spreadsheetId, spreadsheetTitle: meta?.properties?.title || '', sheetName: tab.name, sheetId: tab.sheetId, rows, schema };
    if (!best || schema.confidence > best.schema.confidence) best = candidate;
  }
  if (!best) {
    const error = new Error('No tab has a reliable enrichment schema.');
    error.code = 'UNIVERSAL_SCHEMA_NOT_FOUND';
    throw error;
  }
  await patchRichLinkedInLinks(best.spreadsheetId, best.sheetName, best.rows, best.schema);
  best.schema = schemaTools.inferSchema(best.rows, options.schema || {});
  return best;
}

function companyFromCompanyAnchor(anchor) {
  const values = anchor?.snapshot?.values || {};
  return {
    company: text(values.company || values.name),
    domain: websiteDomain(values.website || ''),
    source: values.linkedin ? 'sheet-company-linkedin' : 'sheet-company',
    anchorLinkedin: values.linkedin || '',
    anchorApolloPersonId: '',
    anchorPerson: null,
  };
}

async function resolvePersonAnchor(plan, row, options = {}) {
  const anchor = plan.anchor;
  const linkedin = anchor?.snapshot?.values?.linkedin || '';
  const normalized = apollo.normalizeLinkedIn(linkedin);
  if (!normalized) return null;
  const group = anchor.group;
  const needEmail = Boolean(group.fields.email && !anchor.snapshot.values.email);
  const needPhone = Boolean(group.fields.phone && !anchor.snapshot.values.phone);
  let profile = await apollo.resolvePersonProfile(normalized, { needEmail, needPhone });
  let company = text(profile?.organizationName || profile?.organization?.name);
  let domain = websiteDomain(profile?.organizationDomain || profile?.organization?.website_url || profile?.organization?.primary_domain || '');
  let employerSource = company ? 'apollo-exact-person' : '';

  if (!company && options.allowLinkedInEmployerFallback !== false) {
    const slug = linkedinSlug(normalized);
    if (slug) {
      const raw = await linkedinMcp.callTool('get_person_profile', { linkedin_username: slug, sections: 'experience', max_scrolls: integer(options.linkedinMaxScrolls, 3, 1, 6) });
      const employer = profileParser.resolveCurrentEmployer(raw);
      if (employer.resolved) {
        company = employer.company;
        employerSource = employer.source;
        profile = { ...profile, title: profile?.title || employer.title, organizationName: company, linkedinEmployerConfidence: employer.confidence };
      }
    }
  }
  if (!company) return { unresolved: true, anchorProfile: profile, anchorLinkedin: normalized };
  return {
    company,
    domain,
    source: employerSource,
    anchorLinkedin: normalized,
    anchorApolloPersonId: text(profile?.apolloPersonId),
    anchorPerson: { ...profile, linkedinUrl: normalized, identityVerified: profile?.ambiguous !== true && profile?.noMatch !== true },
  };
}

function rowCompanyMetadata(plan) {
  const values = plan.anchor?.snapshot?.values || {};
  return {
    companyHeadcount: Number(values.companyHeadcount || 0) || 0,
    location: plan.context?.location || values.location || '',
  };
}

function existingIdentityKeys(plan) {
  const names = new Set();
  const linkedins = new Set();
  for (const item of plan.groups.existing || []) {
    const name = ranker.normalize(String(item.snapshot.values.name || '').replace(/\s+[—–-]\s+.*$/, ''));
    const linkedin = ranker.linkedinKey(item.snapshot.values.linkedin || '');
    if (name) names.add(name);
    if (linkedin) linkedins.add(linkedin);
  }
  return { names, linkedins };
}

function candidateAlreadyPresent(candidate, existing) {
  const name = ranker.normalize(candidate?.name || '');
  const linkedin = ranker.linkedinKey(candidate?.linkedinUrl || candidate?.linkedin_url || '');
  return Boolean((name && existing.names.has(name)) || (linkedin && existing.linkedins.has(linkedin)));
}

async function repairExistingGroups(row, plan, companyContext, stats, options = {}) {
  const changes = [];
  for (const item of plan.groups.partial || []) {
    if (item.isAnchor) continue;
    const group = item.group;
    const snapshot = item.snapshot;
    if (!snapshot.hasIdentity) continue;
    const needEmail = Boolean(group.fields.email && !snapshot.values.email);
    const needPhone = Boolean(group.fields.phone && !snapshot.values.phone);
    let resolved = null;
    try {
      if (snapshot.linkedinKind === 'linkedin_person') {
        resolved = await apollo.resolvePersonProfile(snapshot.values.linkedin, { needEmail, needPhone });
      } else if (snapshot.values.name && companyContext.company) {
        resolved = await apollo.resolvePersonByNameCompany(snapshot.values.name, companyContext.company, companyContext.domain, { needEmail, needPhone });
      }
    } catch {
      stats.existingVerificationFailures++;
      continue;
    }
    stats.existingVerificationAttempts++;
    if (!resolved || resolved.noMatch || resolved.ambiguous || resolved.identityVerified === false || !ranker.sameEmployer(resolved, companyContext)) {
      stats.existingVerificationFailures++;
      continue;
    }
    const writePlan = planner.safeWritesForGroup(row, group, resolved, { allowRoleNormalization: Boolean(options.allowRoleNormalization) });
    if (!writePlan.allowed) { stats.identityConflicts++; continue; }
    changes.push(...writePlan.writes);
    if (writePlan.writes.length) stats.existingGroupsRepaired++;
  }
  return changes;
}

async function enrichAnchorGroup(row, plan, companyContext, stats) {
  if (plan.anchor?.type !== 'person' || !companyContext.anchorPerson) return [];
  const writePlan = planner.safeWritesForGroup(row, plan.anchor.group, companyContext.anchorPerson);
  if (!writePlan.allowed) { stats.identityConflicts++; return []; }
  if (writePlan.writes.length) stats.anchorFieldsFilled += writePlan.writes.length;
  return writePlan.writes;
}

async function discoverCompanyPeople(companyContext, cache, stats, options = {}) {
  const key = `${ranker.companyKey(companyContext.company)}|${ranker.hostname(companyContext.domain)}`;
  if (cache.has(key)) { stats.candidateCacheHits++; return cache.get(key); }
  const result = await apollo.searchCompanyPeopleBroad({
    company: companyContext.company,
    domain: companyContext.domain,
    location: options.location || '',
    limit: integer(options.candidateLimit, 100, 10, 100),
    titles: [],
  });
  stats.candidateSearches++;
  stats.candidatesDiscovered += result.people?.length || 0;
  cache.set(key, result.people || []);
  return result.people || [];
}

async function fillOpenGroups(row, plan, companyContext, candidates, stats, options = {}) {
  const targets = plan.groups.open.filter((item) => !item.isAnchor);
  if (!targets.length) return [];
  const existing = existingIdentityKeys(plan);
  const available = candidates.filter((candidate) => !candidateAlreadyPresent(candidate, existing));
  const context = {
    ...plan.context,
    ...rowCompanyMetadata(plan),
    company: companyContext.company,
    companyDomain: companyContext.domain,
    anchorApolloPersonId: companyContext.anchorApolloPersonId,
    anchorLinkedin: companyContext.anchorLinkedin,
  };
  const ranking = ranker.rankCandidates(available, context, {
    minimumScore: options.minimumScore ?? 38,
  });
  stats.candidatesRanked += ranking.ranked.length;
  const queue = [...ranking.ranked];
  const writes = [];
  const claimed = new Set();

  for (const target of targets) {
    let filled = false;
    while (queue.length && !filled) {
      const selection = queue.shift();
      if (selection.confidence < Number(options.minimumConfidence ?? 0.56)) { stats.lowConfidenceCandidates++; continue; }
      const raw = selection.candidate;
      const key = String(raw.id || raw.apolloPersonId || raw.linkedinUrl || '');
      if (!key || claimed.has(key)) continue;
      claimed.add(key);
      stats.hydrationAttempts++;
      let person;
      try {
        person = await apollo.resolveDecisionMaker(raw, companyContext.company, companyContext.domain, {
          needEmail: Boolean(target.group.fields.email),
          needPhone: Boolean(target.group.fields.phone),
        });
      } catch {
        stats.hydrationFailures++;
        continue;
      }
      const hydratedName = ranker.normalize(person?.name || '');
      const hydratedLinkedin = ranker.linkedinKey(person?.linkedinUrl || person?.returnedLinkedIn || '');
      if (!person?.identityVerified || !person?.title || !ranker.sameEmployer(person, companyContext) || existing.names.has(hydratedName) || existing.linkedins.has(hydratedLinkedin)) {
        stats.hydrationFailures++;
        continue;
      }
      const writePlan = planner.safeWritesForGroup(row, target.group, person);
      if (!writePlan.allowed || !writePlan.writes.length) { stats.identityConflicts++; continue; }
      writes.push(...writePlan.writes);
      existing.names.add(hydratedName);
      if (hydratedLinkedin) existing.linkedins.add(hydratedLinkedin);
      stats.newPeopleSelected++;
      filled = true;
    }
    if (!filled) stats.unfilledOpenGroups++;
  }
  return writes;
}

function toSheetChanges(sheetName, rowNumber, writes) {
  return (writes || []).map((write) => ({
    range: sheets.cellRange(sheetName, rowNumber, write.columnIndex),
    value: write.value,
    field: write.field,
    groupId: write.groupId,
  }));
}

function freshStats() {
  return {
    rowsSeen: 0,
    rowsProcessed: 0,
    rowsWithoutAnchor: 0,
    rowsWithoutEmployer: 0,
    rowsChanged: 0,
    cellsChanged: 0,
    anchorsResolved: 0,
    anchorFieldsFilled: 0,
    candidateSearches: 0,
    candidateCacheHits: 0,
    candidatesDiscovered: 0,
    candidatesRanked: 0,
    existingVerificationAttempts: 0,
    existingVerificationFailures: 0,
    existingGroupsRepaired: 0,
    newPeopleSelected: 0,
    hydrationAttempts: 0,
    hydrationFailures: 0,
    lowConfidenceCandidates: 0,
    unfilledOpenGroups: 0,
    identityConflicts: 0,
    modelCalls: 0,
  };
}

async function run(request = {}, options = {}) {
  const sheetUrl = request.sheetUrl || request.url;
  if (!sheetUrl) throw new Error('Universal enrichment requires a Google Sheet URL.');
  const source = await readUniversalSheet(sheetUrl, { ...options, sheetName: request.sheetName || options.sheetName });
  const analysis = require('./universal-enrichment-engine').analyzeSheet(source.rows, { rowLimit: options.rowLimit, schema: options.schema });
  if (options.dryRun) return { ok: true, dryRun: true, ...source, analysis, stats: { ...freshStats(), rowsSeen: analysis.stats.dataRows } };
  if (options.apolloApproved !== true) {
    const error = new Error('Apollo approval is required before universal enrichment can query paid person enrichment.');
    error.code = 'APOLLO_APPROVAL_REQUIRED';
    error.schema = require('./universal-enrichment-engine').schemaSummary(source.schema);
    throw error;
  }

  const stats = freshStats();
  const employerCache = new Map();
  const rowLimit = integer(options.rowLimit, Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER);
  let processed = 0;
  for (const record of analysis.rowPlans) {
    if (processed >= rowLimit) break;
    stats.rowsSeen++;
    processed++;
    const { row, rowNumber, plan } = record;
    if (!plan.anchor) { stats.rowsWithoutAnchor++; continue; }

    let companyContext;
    if (plan.anchor.type === 'company') companyContext = companyFromCompanyAnchor(plan.anchor);
    else companyContext = await resolvePersonAnchor(plan, row, options);
    if (!companyContext || companyContext.unresolved || !companyContext.company) { stats.rowsWithoutEmployer++; continue; }
    stats.anchorsResolved++;

    const writes = [];
    writes.push(...await enrichAnchorGroup(row, plan, companyContext, stats));
    writes.push(...await repairExistingGroups(row, plan, companyContext, stats, options));

    const openGroups = plan.groups.open.filter((item) => !item.isAnchor);
    if (openGroups.length) {
      const people = await discoverCompanyPeople(companyContext, employerCache, stats, { ...options, location: plan.context?.location || '' });
      writes.push(...await fillOpenGroups(row, plan, companyContext, people, stats, options));
    }

    const byColumn = new Map();
    for (const write of writes) if (!byColumn.has(write.columnIndex)) byColumn.set(write.columnIndex, write);
    const changes = toSheetChanges(source.sheetName, rowNumber, [...byColumn.values()]);
    if (changes.length) {
      await sheets.writeCells(source.spreadsheetId, changes);
      stats.cellsChanged += changes.length;
      stats.rowsChanged++;
    }
    stats.rowsProcessed++;
  }

  return {
    ok: true,
    deterministic: true,
    modelCalls: 0,
    spreadsheetId: source.spreadsheetId,
    spreadsheetTitle: source.spreadsheetTitle,
    sheetName: source.sheetName,
    schema: require('./universal-enrichment-engine').schemaSummary(source.schema),
    analysis: analysis.stats,
    stats,
  };
}

function formatResult(result) {
  const s = result?.stats || {};
  return `Universal deterministic enrichment finished on ${result.sheetName}. Processed ${s.rowsProcessed}/${s.rowsSeen} rows; changed ${s.cellsChanged} cells across ${s.rowsChanged} rows; resolved ${s.anchorsResolved} anchors; repaired ${s.existingGroupsRepaired} existing contact groups; selected ${s.newPeopleSelected} new people. Discovery: ${s.candidatesDiscovered} candidates from ${s.candidateSearches} employer searches (${s.candidateCacheHits} cache hits), ${s.candidatesRanked} passed deterministic ranking. Hydration: ${s.hydrationAttempts} attempts, ${s.hydrationFailures} failures. Unfilled open groups: ${s.unfilledOpenGroups}; rows without anchor ${s.rowsWithoutAnchor}; rows without verified employer ${s.rowsWithoutEmployer}; identity conflicts ${s.identityConflicts}. AI/model calls: 0.`;
}

module.exports = {
  schemaLinkedInColumns,
  patchRichLinkedInLinks,
  readUniversalSheet,
  companyFromCompanyAnchor,
  resolvePersonAnchor,
  existingIdentityKeys,
  candidateAlreadyPresent,
  repairExistingGroups,
  fillOpenGroups,
  run,
  formatResult,
};
