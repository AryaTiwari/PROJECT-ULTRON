'use strict';

// Universal deterministic spreadsheet enrichment executor.
// No model/router dependency is permitted in this file.

const sheets = require('./google-sheets-operator');
const apollo = require('./apollo-enrichment');
const linkedinMcp = require('./linkedin-mcp-client');
const schemaTools = require('./universal-sheet-schema');
const planner = require('./universal-enrichment-planner');
const ranker = require('./universal-authority-ranker');
const profileParser = require('./universal-linkedin-profile-parser');
const orphanPolicy = require('./universal-orphan-contact-policy');
const engine = require('./universal-enrichment-engine');
const typedErrors = require('./spreadsheet-enrichment-errors');

function text(value) { return String(value ?? '').trim(); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function integer(value, fallback, min = 1, max = 100000) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
}
function websiteDomain(value) { return ranker.hostname(value); }
function linkedinSlug(value) {
  const normalized = apollo.normalizeLinkedIn(value);
  if (!normalized) return '';
  try { return decodeURIComponent(new URL(normalized).pathname.match(/^\/in\/([^/]+)/i)?.[1] || '').trim(); } catch { return ''; }
}

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
  const tabs = (meta.sheets || []).map((sheet) => ({ name: sheet?.properties?.title, sheetId: sheet?.properties?.sheetId })).filter((sheet) => sheet.name);
  const targets = requestedName ? tabs.filter((tab) => tab.name === requestedName) : tabs;
  if (!targets.length) {
    const error = new Error(requestedName ? `Google Sheet tab not found: ${requestedName}` : 'Spreadsheet has no readable tabs.');
    error.code = 'UNIVERSAL_SHEET_TAB_NOT_FOUND';
    throw error;
  }

  let best = null;
  for (const tab of targets) {
    const rows = await sheets.values(spreadsheetId, `${sheets.quoteSheet(tab.name)}!A:ZZ`);
    let schema;
    try { schema = schemaTools.inferSchema(rows, options.schema || {}); }
    catch (error) { if (requestedName) throw error; else continue; }
    const candidate = { spreadsheetId, spreadsheetTitle: meta?.properties?.title || '', sheetName: tab.name, sheetId: tab.sheetId, rows, schema };
    if (!best || schema.confidence > best.schema.confidence) best = candidate;
  }
  if (!best) {
    const error = new Error('No worksheet has a reliable enrichment schema.');
    error.code = 'UNIVERSAL_SCHEMA_NOT_FOUND';
    throw error;
  }
  await patchRichLinkedInLinks(best.spreadsheetId, best.sheetName, best.rows, best.schema);
  best.schema = schemaTools.inferSchema(best.rows, options.schema || {});
  return best;
}

function companyFromCompanyAnchor(anchor) {
  const values = anchor?.snapshot?.values || {};
  const company = text(values.company || values.name);
  const domain = websiteDomain(values.website || '');
  return company ? {
    company,
    domain,
    source: values.linkedin ? 'sheet-company-linkedin' : 'sheet-company',
    anchorLinkedin: values.linkedin || '',
    anchorApolloPersonId: '',
    anchorPerson: null,
  } : null;
}

function nearestCompanyIdentity(plan) {
  const values = plan.anchor?.snapshot?.values || {};
  if (values.company) return text(values.company);
  for (const item of plan.groups?.existing || []) {
    const company = text(item.snapshot?.values?.company);
    if (company) return company;
  }
  return text(plan.context?.company || '');
}

async function resolvePersonAnchor(plan, row, options = {}) {
  const anchor = plan.anchor;
  if (!anchor || anchor.type !== 'person') return null;
  const values = anchor.snapshot?.values || {};
  const group = anchor.group;
  const needEmail = Boolean(group.fields.email && !values.email);
  const needPhone = Boolean(group.fields.phone && !values.phone);
  const normalizedLinkedin = apollo.normalizeLinkedIn(values.linkedin || '');
  let profile = null;
  let company = '';
  let domain = '';
  let source = '';

  if (normalizedLinkedin) {
    try { profile = await apollo.resolvePersonProfile(normalizedLinkedin, { needEmail, needPhone }); } catch {}
    company = text(profile?.organizationName || profile?.organization?.name);
    domain = websiteDomain(profile?.organizationDomain || profile?.organization?.website_url || profile?.organization?.primary_domain || '');
    source = company ? 'apollo-exact-person' : '';

    if (!company && options.allowLinkedInEmployerFallback !== false) {
      const slug = linkedinSlug(normalizedLinkedin);
      if (slug) {
        try {
          const raw = await linkedinMcp.callTool('get_person_profile', {
            linkedin_username: slug,
            sections: 'experience',
            max_scrolls: integer(options.linkedinMaxScrolls, 3, 1, 6),
          });
          const employer = profileParser.resolveCurrentEmployer(raw);
          if (employer.resolved) {
            company = employer.company;
            source = employer.source;
            profile = { ...(profile || {}), title: profile?.title || employer.title, organizationName: company, linkedinEmployerConfidence: employer.confidence };
          }
        } catch {}
      }
    }
  } else if (values.name) {
    const explicitCompany = nearestCompanyIdentity(plan);
    if (explicitCompany) {
      try {
        profile = await apollo.resolvePersonByNameCompany(values.name, explicitCompany, '', { needEmail, needPhone });
      } catch {}
      if (profile && !profile.noMatch && !profile.ambiguous && profile.identityVerified !== false) {
        company = text(profile.organizationName || profile.organization?.name || explicitCompany);
        domain = websiteDomain(profile.organizationDomain || profile.organization?.website_url || profile.organization?.primary_domain || '');
        source = 'apollo-name-company';
      }
    }
  }

  if (!company) return { unresolved: true, anchorProfile: profile, anchorLinkedin: normalizedLinkedin || '' };
  return {
    company,
    domain,
    source,
    anchorLinkedin: normalizedLinkedin || apollo.normalizeLinkedIn(profile?.linkedinUrl || ''),
    anchorApolloPersonId: text(profile?.apolloPersonId || profile?.id),
    anchorPerson: profile ? { ...profile, linkedinUrl: normalizedLinkedin || profile.linkedinUrl || '', identityVerified: profile?.ambiguous !== true && profile?.noMatch !== true && profile?.identityVerified !== false } : null,
  };
}

function existingIdentityKeys(plan) {
  const names = new Set();
  const linkedins = new Set();
  for (const item of plan.groups?.existing || []) {
    const name = ranker.normalize(String(item.snapshot?.values?.name || '').replace(/\s+[—–-]\s+.*$/, ''));
    const linkedin = ranker.linkedinKey(item.snapshot?.values?.linkedin || '');
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

function needsEmbeddedDesignationRepair(item) {
  if (!item || item.isAnchor) return false;
  const name = text(item.snapshot?.values?.name);
  return Boolean(
    item.snapshot?.hasIdentity
    && name
    && planner.shouldEmbedRoleInName(item.group)
    && !planner.hasEmbeddedDesignation(name)
  );
}

function candidateFillTargets(plan) {
  const targets = new Map();
  for (const item of plan.groups?.open || []) {
    if (!item.isAnchor) targets.set(item.group.id, item);
  }
  for (const item of plan.groups?.partial || []) {
    if (orphanPolicy.isOrphanContactTarget(item)) targets.set(item.group.id, item);
  }
  return [...targets.values()].sort((a, b) => (a.group.ordinal || 999) - (b.group.ordinal || 999));
}

function existingRepairNeedsDiscovery(plan) {
  return (plan?.groups?.partial || []).some((item) =>
    !item.isAnchor
    && item.snapshot?.hasIdentity
    && item.snapshot?.values?.name
    && item.snapshot?.linkedinKind !== 'linkedin_person'
    && (
      (item.group?.fields?.phone && !item.snapshot?.values?.phone)
      || (item.group?.fields?.email && !item.snapshot?.values?.email)
      || needsEmbeddedDesignationRepair(item)
    )
  );
}

function exactCandidateForExisting(item, candidates = [], companyContext = {}) {
  const wanted = planner.normalizeName(item?.snapshot?.values?.name || '');
  if (!wanted) return null;
  const matches = (Array.isArray(candidates) ? candidates : []).filter((candidate) =>
    planner.normalizeName(candidate?.name || '') === wanted
    && ranker.sameEmployer(candidate, companyContext)
  );
  if (matches.length !== 1) return null;
  return matches[0];
}

function queuePendingPhone(options, rowNumber, group, snapshot, person) {
  const queue = options?.pendingPhoneQueue;
  if (!Array.isArray(queue) || !Number.isInteger(rowNumber) || !group?.fields?.phone) return;
  if (text(snapshot?.values?.phone)) return;
  const apolloPersonId = text(person?.apolloPersonId || person?.id);
  if (!apolloPersonId || text(person?.phone) || person?.phoneStatus !== 'pending') return;
  const key = `${rowNumber}|${group.fields.phone.index}|${apolloPersonId}`;
  if (queue.some((item) => item.key === key)) return;
  queue.push({
    key,
    rowNumber,
    columnIndex: group.fields.phone.index,
    groupId: group.id,
    apolloPersonId,
    personName: text(person?.name),
  });
}

function phoneSyncPolls(options = {}) {
  const raw = Number(options.phoneSyncPolls ?? process.env.ULTRON_M3_APOLLO_PHONE_SYNC_POLLS ?? 8);
  return Number.isFinite(raw) ? Math.max(1, Math.min(10, Math.floor(raw))) : 8;
}

function phoneSyncWaitMs(options = {}) {
  const raw = Number(options.phoneSyncWaitMs ?? process.env.ULTRON_M3_APOLLO_PHONE_SYNC_WAIT_MS ?? 1800);
  return Number.isFinite(raw) ? Math.max(250, Math.min(5000, Math.floor(raw))) : 1800;
}

async function syncPendingPhoneAssignments(source, queue = [], stats, options = {}) {
  const pending = Array.isArray(queue) ? queue.filter((item) => item?.apolloPersonId) : [];
  stats.pendingPhoneRequests = pending.length;
  if (!pending.length) return;

  const unresolved = new Map(pending.map((item) => [item.key, item]));
  const handledProviderIds = new Set();
  const polls = phoneSyncPolls(options);
  const waitMs = phoneSyncWaitMs(options);

  for (let attempt = 0; attempt < polls && unresolved.size; attempt++) {
    if (attempt > 0) await sleep(waitMs);
    let results = [];
    try {
      results = await apollo.fetchPhoneResults();
      stats.phoneSyncPolls++;
    } catch (error) {
      stats.phoneSyncErrors++;
      stats.phoneSyncLastError = typedFailureSummary(error, { stage: 'apollo-phone-result-sync' });
      break;
    }
    if (!Array.isArray(results) || !results.length) continue;

    const byId = new Map();
    for (const result of results) {
      const id = text(result?.apollo_person_id);
      if (id) byId.set(id, result);
    }

    const changes = [];
    const resolvedKeys = [];
    for (const [key, item] of unresolved.entries()) {
      const result = byId.get(item.apolloPersonId);
      if (!result) continue;
      const phone = apollo.validPhone(result?.phone);
      apollo.recordPhoneResult(item.apolloPersonId, phone);
      handledProviderIds.add(item.apolloPersonId);
      if (!phone) {
        resolvedKeys.push(key);
        stats.phoneNotFound++;
        continue;
      }

      const range = sheets.cellRange(source.sheetName, item.rowNumber, item.columnIndex);
      let current = '';
      try { current = await sheets.readCell(source.spreadsheetId, range); } catch {}
      if (!sheets.isBlank(current)) {
        resolvedKeys.push(key);
        stats.phoneWriteSkippedPopulated++;
        continue;
      }
      changes.push({ range, value: phone, rowNumber: item.rowNumber });
      resolvedKeys.push(key);
    }

    if (changes.length) {
      await sheets.writeCells(source.spreadsheetId, changes);
      stats.phoneCellsFilled += changes.length;
      stats.cellsChanged += changes.length;
      const phoneRows = new Set(changes.map((change) => change.rowNumber));
      stats.phoneRowsChanged += phoneRows.size;
    }
    for (const key of resolvedKeys) unresolved.delete(key);
  }

  for (const apolloPersonId of handledProviderIds) {
    try { await apollo.consumePhoneResult(apolloPersonId); } catch {}
  }
  stats.phoneStillPending = unresolved.size;
}

async function repairExistingGroups(row, plan, companyContext, stats, options = {}) {
  const writes = [];
  const targets = new Map();
  for (const item of plan.groups?.partial || []) if (!item.isAnchor) targets.set(item.group.id, item);
  for (const item of plan.groups?.existing || []) {
    if (needsEmbeddedDesignationRepair(item)) targets.set(item.group.id, item);
  }

  const candidatePool = Array.isArray(options.candidatePool) ? options.candidatePool : [];
  for (const item of targets.values()) {
    const group = item.group;
    const snapshot = item.snapshot;
    if (!snapshot.hasIdentity) continue;
    const needEmail = Boolean(group.fields.email && !snapshot.values.email);
    const needPhone = Boolean(group.fields.phone && !snapshot.values.phone);
    let resolved = null;
    let verificationPath = '';
    stats.existingVerificationAttempts++;

    try {
      if (snapshot.linkedinKind === 'linkedin_person') {
        verificationPath = 'exact-linkedin';
        resolved = await apollo.resolvePersonProfile(snapshot.values.linkedin, { needEmail, needPhone });
      } else if (snapshot.values.name && companyContext.company) {
        const exactCandidate = exactCandidateForExisting(item, candidatePool, companyContext);
        if (exactCandidate) {
          verificationPath = 'same-company-discovery-exact-name';
          stats.existingDiscoveryIdentityMatches++;
          resolved = await apollo.resolveDecisionMaker(exactCandidate, companyContext.company, companyContext.domain, { needEmail, needPhone });
        } else {
          verificationPath = 'apollo-name-company';
          resolved = await apollo.resolvePersonByNameCompany(snapshot.values.name, companyContext.company, companyContext.domain, { needEmail, needPhone });
        }
      }
    } catch (error) {
      stats.existingVerificationFailures++;
      stats.existingRepairAudit.push({
        rowNumber: options.rowNumber || null,
        groupId: group.id,
        name: snapshot.values.name || '',
        path: verificationPath || 'unresolved',
        status: 'verification-error',
        code: String(error?.code || 'APOLLO_EXISTING_CONTACT_VERIFY_FAILED'),
        message: String(error?.message || error || '').slice(0, 240),
      });
      continue;
    }

    if (!resolved || resolved.noMatch || resolved.ambiguous || resolved.identityVerified === false || !ranker.sameEmployer(resolved, companyContext)) {
      stats.existingVerificationFailures++;
      stats.existingRepairAudit.push({
        rowNumber: options.rowNumber || null,
        groupId: group.id,
        name: snapshot.values.name || '',
        path: verificationPath || 'unresolved',
        status: 'identity-or-employer-not-verified',
      });
      continue;
    }

    queuePendingPhone(options, Number(options.rowNumber), group, snapshot, resolved);
    const planWrite = planner.safeWritesForGroup(row, group, resolved, { allowRoleNormalization: Boolean(options.allowRoleNormalization) });
    if (!planWrite.allowed) {
      stats.identityConflicts++;
      stats.existingRepairAudit.push({
        rowNumber: options.rowNumber || null,
        groupId: group.id,
        name: snapshot.values.name || '',
        path: verificationPath,
        status: 'identity-conflict',
      });
      continue;
    }

    writes.push(...planWrite.writes);
    stats.embeddedDesignationWrites += planWrite.writes.filter((write) => write.embeddedRole).length;
    if (planWrite.writes.length) stats.existingGroupsRepaired++;
    stats.existingRepairAudit.push({
      rowNumber: options.rowNumber || null,
      groupId: group.id,
      name: snapshot.values.name || '',
      path: verificationPath,
      status: planWrite.writes.length ? 'repaired' : (needPhone && resolved.phoneStatus === 'pending' ? 'phone-pending' : 'verified-no-new-data'),
      fields: planWrite.writes.map((write) => write.field),
    });
  }
  return writes;
}

async function enrichAnchorGroup(row, plan, companyContext, stats, options = {}) {
  if (plan.anchor?.type !== 'person' || !companyContext.anchorPerson) return [];
  queuePendingPhone(options, Number(options.rowNumber), plan.anchor.group, plan.anchor.snapshot, companyContext.anchorPerson);
  const writePlan = planner.safeWritesForGroup(row, plan.anchor.group, companyContext.anchorPerson);
  if (!writePlan.allowed) { stats.identityConflicts++; return []; }
  stats.anchorFieldsFilled += writePlan.writes.length;
  stats.embeddedDesignationWrites += writePlan.writes.filter((write) => write.embeddedRole).length;
  return writePlan.writes;
}

function candidateDiscoveryKey(candidate = {}) {
  return String(
    candidate.apolloPersonId
    || candidate.id
    || candidate.linkedinUrl
    || candidate.linkedin_url
    || `${ranker.normalize(candidate.name || '')}|${ranker.normalize(candidate.title || '')}`
  ).trim().toLowerCase();
}

function mergeCandidatePools(...pools) {
  const out = [];
  const seen = new Set();
  for (const pool of pools) {
    for (const candidate of Array.isArray(pool) ? pool : []) {
      const key = candidateDiscoveryKey(candidate);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(candidate);
    }
  }
  return out;
}

function companyPriorityTitles() {
  return (apollo.COMPANY_DECISION_PRIORITY || [])
    .flatMap((tier) => Array.isArray(tier?.titles) ? tier.titles : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function companyPriorityCandidate(candidate = {}) {
  return Number(apollo.decisionPriority(candidate.title || candidate.headline || '')) < 99;
}

async function discoverCompanyPeople(companyContext, cache, stats, options = {}) {
  const key = `${ranker.companyKey(companyContext.company)}|${ranker.hostname(companyContext.domain)}|${ranker.normalize(options.location || '')}`;
  if (cache.has(key)) { stats.candidateCacheHits++; return cache.get(key); }

  const broadResult = await apollo.searchCompanyPeopleBroad({
    company: companyContext.company,
    domain: companyContext.domain,
    location: options.location || '',
    limit: integer(options.candidateLimit, 100, 10, 100),
    titles: [],
  });
  stats.candidateSearches++;
  stats.candidateBroadSearches++;
  const broadPeople = Array.isArray(broadResult?.people) ? broadResult.people : [];

  // Broad discovery remains first and authoritative. If it happens to return an
  // employee slice with too few useful decision-maker/recruiting contacts, run
  // one cheap title-targeted discovery pass before spending hydration credits.
  const minimumPriorityPool = integer(options.minimumPriorityPool, 6, 2, 20);
  const broadPriorityCount = broadPeople.filter(companyPriorityCandidate).length;
  let targetedPeople = [];
  if (broadPriorityCount < minimumPriorityPool) {
    try {
      const targetedResult = await apollo.searchCompanyPeopleBroad({
        company: companyContext.company,
        domain: companyContext.domain,
        location: options.location || '',
        limit: integer(options.priorityCandidateLimit, 50, 10, 100),
        titles: companyPriorityTitles(),
      });
      stats.candidateSearches++;
      stats.candidatePrioritySearches++;
      targetedPeople = Array.isArray(targetedResult?.people) ? targetedResult.people : [];
    } catch (error) {
      // Supplemental discovery must not erase a successful broad search. Keep the
      // row usable and expose the diagnostic in stats.
      stats.candidatePrioritySearchFailures++;
      stats.discoveryDiagnostics.push({
        company: companyContext.company,
        code: String(error?.code || 'APOLLO_PRIORITY_SEARCH_FAILED'),
        message: String(error?.message || error || '').slice(0, 300),
      });
    }
  }

  const people = mergeCandidatePools(broadPeople, targetedPeople);
  stats.candidatesDiscovered += people.length;
  cache.set(key, people);
  return people;
}

function rowCompanyMetadata(plan) {
  const values = plan.anchor?.snapshot?.values || {};
  return {
    companyHeadcount: Number(values.companyHeadcount || 0) || 0,
    location: plan.context?.location || values.location || '',
  };
}

async function fillOpenGroups(row, plan, companyContext, candidates, stats, options = {}) {
  const targets = candidateFillTargets(plan);
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
  const ranking = ranker.rankCandidates(available, context, { minimumScore: options.minimumScore });
  stats.candidatesRanked += ranking.ranked.length;
  stats.rankingThresholds.push(Number(ranking.threshold || 0));
  const writes = [];
  const claimed = new Set();
  const hydratedCache = new Map();

  for (const target of targets) {
    const orphanTarget = orphanPolicy.isOrphanContactTarget(target);
    if (orphanTarget) stats.orphanContactTargets++;
    let filled = false;

    for (const selection of ranking.ranked) {
      if (filled) break;
      if (selection.confidence < Number(options.minimumConfidence ?? 0.54)) {
        stats.lowConfidenceCandidates++;
        continue;
      }

      const raw = selection.candidate;
      const rawKey = String(raw.apolloPersonId || raw.id || raw.linkedinUrl || raw.linkedin_url || '');
      if (!rawKey || claimed.has(rawKey)) continue;

      let person;
      if (hydratedCache.has(rawKey)) {
        person = hydratedCache.get(rawKey);
      } else {
        stats.hydrationAttempts++;
        try {
          person = await apollo.resolveDecisionMaker(raw, companyContext.company, companyContext.domain, {
            needEmail: Boolean(target.group.fields.email),
            needPhone: Boolean(target.group.fields.phone),
          });
        } catch {
          person = null;
        }
        hydratedCache.set(rawKey, person || null);
        if (!person?.identityVerified || !person?.title || !ranker.sameEmployer(person, companyContext)) {
          stats.hydrationFailures++;
        }
      }

      if (!person?.identityVerified || !person?.title || !ranker.sameEmployer(person, companyContext)) continue;
      const hydratedName = ranker.normalize(person?.name || '');
      const hydratedLinkedin = ranker.linkedinKey(person?.linkedinUrl || person?.returnedLinkedIn || '');
      if ((hydratedName && existing.names.has(hydratedName)) || (hydratedLinkedin && existing.linkedins.has(hydratedLinkedin))) {
        stats.postHydrationDuplicates++;
        continue;
      }

      if (orphanTarget) {
        const contactProof = orphanPolicy.verify(target.snapshot, person);
        if (!contactProof.verified) {
          stats.orphanContactMismatches++;
          continue;
        }
        stats.orphanContactVerified++;
      }

      queuePendingPhone(options, Number(options.rowNumber), target.group, target.snapshot, person);
      const writePlan = planner.safeWritesForGroup(row, target.group, person);
      if (!writePlan.allowed || !writePlan.writes.length) {
        stats.identityConflicts++;
        continue;
      }

      writes.push(...writePlan.writes);
      stats.embeddedDesignationWrites += writePlan.writes.filter((write) => write.embeddedRole).length;
      if (hydratedName) existing.names.add(hydratedName);
      if (hydratedLinkedin) existing.linkedins.add(hydratedLinkedin);
      claimed.add(rawKey);
      stats.newPeopleSelected++;
      stats.selectionAudit.push({
        groupId: target.group.id,
        apolloPersonId: text(person.apolloPersonId || person.id),
        name: person.name || '',
        title: person.title || '',
        score: selection.score,
        confidence: selection.confidence,
        proof: [
          ...(selection.proof || []),
          ...(orphanTarget ? orphanPolicy.verify(target.snapshot, person).proof.map((proof) => `orphan-${proof}`) : []),
        ],
      });
      filled = true;
    }

    if (!filled) {
      stats.unfilledOpenGroups++;
      if (orphanTarget) stats.orphanContactBlocked++;
    }
  }
  return writes;
}

function toSheetChanges(sheetName, rowNumber, writes) {
  return (writes || []).map((write) => ({ range: sheets.cellRange(sheetName, rowNumber, write.columnIndex), value: write.value, field: write.field, groupId: write.groupId }));
}

function typedFailureSummary(error, context = {}) {
  const typed = typedErrors.normalize(error, context);
  return {
    code: typed.code,
    subsystem: typed.subsystem,
    type: typed.type,
    stage: typed.stage,
    message: typed.message,
    hint: typed.hint,
    status: typed.status,
    retryAttempts: typed.retryAttempts,
    attemptedRange: typed.attemptedRange || null,
  };
}

function isRecoverableRowFailure(typed = {}) {
  const subsystem = text(typed.subsystem).toUpperCase();
  const type = text(typed.type).toUpperCase();
  const code = text(typed.code).toUpperCase();

  // Google targeting/auth/write failures are workbook-level. Continuing would
  // either repeat a broken write path or risk misleading partial state.
  if (subsystem === 'GOOGLE_SHEETS' || subsystem === 'TARGETING' || subsystem === 'CONTROL_PLANE' || subsystem === 'SCHEMA') return false;

  // Apollo transport/auth/quota/config failures are provider-wide, not row-local.
  if (subsystem === 'APOLLO') {
    if (['AUTH', 'PERMISSION', 'RATE_LIMIT', 'NETWORK', 'CONFIG'].includes(type)) return false;
    if (/NOT_CONFIGURED|ACCESS_REQUIRED|AUTH_REQUIRED|RATE_LIMIT/.test(code)) return false;
    // Company/person-specific Apollo API misses/bad requests may safely leave the
    // current row unresolved while later rows continue.
    return true;
  }

  if (subsystem === 'LINKEDIN') {
    return !['AUTH', 'PERMISSION', 'RATE_LIMIT', 'NETWORK', 'CONFIG'].includes(type);
  }

  return ['NOT_FOUND', 'AMBIGUITY'].includes(type);
}

function isTransientProviderRowFailure(typed = {}) {
  const subsystem = text(typed.subsystem).toUpperCase();
  const type = text(typed.type).toUpperCase();
  const code = text(typed.code).toUpperCase();
  if (subsystem !== 'APOLLO') return false;
  if (['NETWORK', 'TIMEOUT'].includes(type)) return true;
  return /NETWORK|TIMEOUT|UNAVAILABLE|FETCH_FAILED/.test(code);
}

function formatFailureSummary(typed = {}) {
  return `[${typed.subsystem || 'UNIVERSAL'}/${typed.type || 'INTERNAL'}] ${typed.code || 'UNIVERSAL_INTERNAL_UNCLASSIFIED'} @ ${typed.stage || 'row-enrichment'}: ${typed.message || 'unknown failure'}`;
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
    candidateBroadSearches: 0,
    candidatePrioritySearches: 0,
    candidatePrioritySearchFailures: 0,
    candidateCacheHits: 0,
    candidatesDiscovered: 0,
    postHydrationDuplicates: 0,
    discoveryDiagnostics: [],
    pendingPhoneRequests: 0,
    phoneSyncPolls: 0,
    phoneSyncErrors: 0,
    phoneSyncLastError: null,
    phoneCellsFilled: 0,
    phoneRowsChanged: 0,
    phoneNotFound: 0,
    phoneWriteSkippedPopulated: 0,
    phoneStillPending: 0,
    candidatesRanked: 0,
    existingVerificationAttempts: 0,
    existingVerificationFailures: 0,
    existingDiscoveryIdentityMatches: 0,
    existingGroupsRepaired: 0,
    existingRepairAudit: [],
    embeddedDesignationWrites: 0,
    newPeopleSelected: 0,
    hydrationAttempts: 0,
    hydrationFailures: 0,
    lowConfidenceCandidates: 0,
    unfilledOpenGroups: 0,
    orphanContactTargets: 0,
    orphanContactVerified: 0,
    orphanContactBlocked: 0,
    orphanContactMismatches: 0,
    identityConflicts: 0,
    rankingThresholds: [],
    selectionAudit: [],
    rowFailures: 0,
    recoverableRowFailures: 0,
    transientProviderFailures: 0,
    transientProviderContinuations: 0,
    consecutiveTransientProviderFailures: 0,
    systemicHalts: 0,
    haltedEarly: false,
    haltAtRow: null,
    haltError: null,
    rowFailureAudit: [],
    modelCalls: 0,
  };
}

async function run(request = {}, options = {}) {
  const sheetUrl = request.sheetUrl || request.url;
  if (!sheetUrl) throw new Error('Universal enrichment requires a Google Sheet URL.');
  const source = await readUniversalSheet(sheetUrl, { ...options, sheetName: request.sheetName || options.sheetName });
  const analysis = engine.analyzeSheet(source.rows, { rowLimit: options.rowLimit, schema: options.schema });
  if (options.dryRun) return { ok: true, dryRun: true, deterministic: true, modelCalls: 0, ...source, analysis, schema: engine.schemaSummary(source.schema), stats: { ...freshStats(), rowsSeen: analysis.stats.dataRows } };
  if (options.apolloApproved !== true) {
    const error = new Error('Apollo approval is required before universal enrichment can query paid person enrichment.');
    error.code = 'APOLLO_APPROVAL_REQUIRED';
    error.schema = engine.schemaSummary(source.schema);
    throw error;
  }

  // These wrappers are installed by the deterministic bootstrap, but their
  // accounting/budgets are per approved enrichment run, not process-lifetime.
  try { require('./apollo-three-poc-quality').startRun(); } catch {}
  try { require('./three-poc-candidate-discovery-policy').startRun(); } catch {}

  const stats = freshStats();
  const cache = options.discoveryCache instanceof Map ? options.discoveryCache : new Map();
  const pendingPhoneQueue = [];
  const runOptions = { ...options, discoveryCache: cache, pendingPhoneQueue };
  for (const record of analysis.rowPlans) {
    stats.rowsSeen++;
    const { row, rowNumber, plan } = record;
    if (!plan.anchor) { stats.rowsWithoutAnchor++; continue; }

    try {
      const companyContext = plan.anchor.type === 'company' ? companyFromCompanyAnchor(plan.anchor) : await resolvePersonAnchor(plan, row, options);
      if (!companyContext || companyContext.unresolved || !companyContext.company) { stats.rowsWithoutEmployer++; continue; }
      stats.anchorsResolved++;

      const writes = [];
      const fillTargets = candidateFillTargets(plan);
      const repairDiscoveryNeeded = existingRepairNeedsDiscovery(plan);
      let people = [];
      if (fillTargets.length || repairDiscoveryNeeded) {
        people = await discoverCompanyPeople(companyContext, cache, stats, { ...runOptions, location: plan.context?.location || '' });
      }

      const rowOptions = { ...runOptions, rowNumber, candidatePool: people };
      writes.push(...await enrichAnchorGroup(row, plan, companyContext, stats, rowOptions));
      writes.push(...await repairExistingGroups(row, plan, companyContext, stats, rowOptions));
      if (fillTargets.length) {
        writes.push(...await fillOpenGroups(row, plan, companyContext, people, stats, rowOptions));
      }

      const byColumn = new Map();
      for (const write of writes) if (!byColumn.has(write.columnIndex)) byColumn.set(write.columnIndex, write);
      const changes = toSheetChanges(source.sheetName, rowNumber, [...byColumn.values()]);
      if (changes.length) {
        await sheets.writeCells(source.spreadsheetId, changes);
        stats.rowsChanged++;
        stats.cellsChanged += changes.length;
      }
      stats.rowsProcessed++;
      stats.consecutiveTransientProviderFailures = 0;
    } catch (error) {
      const typed = typedFailureSummary(error, {
        stage: error?.stage || 'primary-row-enrichment',
      });
      stats.rowFailures++;
      stats.rowFailureAudit.push({ rowNumber, ...typed });

      if (isRecoverableRowFailure(typed)) {
        stats.recoverableRowFailures++;
        stats.consecutiveTransientProviderFailures = 0;
        stats.rowsProcessed++;
        continue;
      }

      // Apollo already retries transport failures at the HTTP boundary. One
      // exhausted row-level network failure should still not invalidate or stop
      // unrelated rows immediately. Continue a bounded number of consecutive
      // transient provider failures, then open the circuit and halt safely.
      if (isTransientProviderRowFailure(typed)) {
        const maxTransient = integer(options.maxTransientRowFailures, 2, 1, 5);
        stats.transientProviderFailures++;
        stats.consecutiveTransientProviderFailures++;
        if (stats.consecutiveTransientProviderFailures <= maxTransient) {
          stats.transientProviderContinuations++;
          stats.rowsProcessed++;
          continue;
        }
      } else {
        stats.consecutiveTransientProviderFailures = 0;
      }

      stats.systemicHalts++;
      stats.haltedEarly = true;
      stats.haltAtRow = rowNumber;
      stats.haltError = typed;
      break;
    }
  }

  try {
    await syncPendingPhoneAssignments(source, pendingPhoneQueue, stats, runOptions);
  } catch (error) {
    stats.phoneSyncErrors++;
    stats.phoneSyncLastError = typedFailureSummary(error, { stage: error?.stage || 'apollo-phone-result-sync' });
  }

  return {
    ok: true,
    deterministic: true,
    modelCalls: 0,
    completedFully: !stats.haltedEarly,
    partialCompletion: Boolean(stats.haltedEarly || stats.rowFailures),
    resumeSafe: true,
    spreadsheetId: source.spreadsheetId,
    spreadsheetTitle: source.spreadsheetTitle,
    sheetName: source.sheetName,
    schema: engine.schemaSummary(source.schema),
    analysis: analysis.stats,
    stats,
  };
}

function formatResult(result) {
  const s = result?.stats || {};
  const schema = result?.schema || {};
  const groups = Array.isArray(schema.personGroups) ? schema.personGroups.length : 0;
  const companies = Array.isArray(schema.companyGroups) ? schema.companyGroups.length : 0;
  const ordinalRecovered = Array.isArray(schema.ordinalContactRecoveries) ? schema.ordinalContactRecoveries.length : 0;
  const status = s.haltedEarly
    ? `Universal deterministic enrichment PARTIALLY completed on ${result.sheetName}; execution halted safely at row ${s.haltAtRow} after preserving all earlier verified writes.`
    : `Universal deterministic enrichment finished on ${result.sheetName}.`;
  const rowFailureText = s.rowFailures
    ? ` Row fault containment: ${s.rowFailures} row failure${Number(s.rowFailures) === 1 ? '' : 's'} captured, ${s.recoverableRowFailures || 0} ordinary row-local failure${Number(s.recoverableRowFailures || 0) === 1 ? '' : 's'} continued, ${s.transientProviderContinuations || 0} transient Apollo transport failure${Number(s.transientProviderContinuations || 0) === 1 ? '' : 's'} continued under the circuit breaker, ${s.systemicHalts || 0} systemic halt${Number(s.systemicHalts || 0) === 1 ? '' : 's'}.`
    : ' Row fault containment: no row failures.';
  const haltText = s.haltError
    ? ` Halt cause: ${formatFailureSummary(s.haltError)}. ${s.haltError.hint || ''}${s.haltError.attemptedRange ? ` Attempted range: ${s.haltError.attemptedRange}.` : ''}`
    : '';
  return `${status} Schema: header row ${schema.headerRowNumber || '?'}, ${groups} person/contact groups, ${companies} company groups, confidence ${Number(schema.confidence || 0).toFixed(2)}; ${ordinalRecovered} ordinal contact groups recovered structurally. Processed ${s.rowsProcessed}/${s.rowsSeen} rows; changed ${s.cellsChanged} cells across ${s.rowsChanged} rows; resolved ${s.anchorsResolved} anchors; repaired ${s.existingGroupsRepaired} existing groups; selected ${s.newPeopleSelected} new people. Embedded verified designations in ${s.embeddedDesignationWrites || 0} contact-name writes where no dedicated role column existed. Discovery: ${s.candidatesDiscovered} unique candidates from ${s.candidateSearches} Apollo discovery calls (${s.candidateBroadSearches || 0} broad, ${s.candidatePrioritySearches || 0} priority-targeted, ${s.candidatePrioritySearchFailures || 0} supplemental failures, ${s.candidateCacheHits} cache hits); ${s.candidatesRanked} candidates passed deterministic ranking. Hydration: ${s.hydrationAttempts} attempts, ${s.hydrationFailures} failures; ${s.postHydrationDuplicates || 0} hydrated identities were already present and were skipped before trying the next candidate. Existing-contact repair: ${s.existingVerificationAttempts || 0} verification attempts, ${s.existingDiscoveryIdentityMatches || 0} exact same-company discovery matches, ${s.existingGroupsRepaired || 0} groups repaired, ${s.existingVerificationFailures || 0} verification failures. Phone completion: ${s.pendingPhoneRequests || 0} async Apollo phone requests tracked, ${s.phoneCellsFilled || 0} phone cells filled after webhook sync, ${s.phoneNotFound || 0} confirmed unavailable, ${s.phoneStillPending || 0} still pending, ${s.phoneSyncErrors || 0} sync errors. Orphan-contact safety: ${s.orphanContactTargets || 0} identity-less partial targets, ${s.orphanContactVerified || 0} verified by matching existing contact data, ${s.orphanContactBlocked || 0} blocked, ${s.orphanContactMismatches || 0} candidate/contact mismatches. Unfilled target groups: ${s.unfilledOpenGroups}; rows without anchor ${s.rowsWithoutAnchor}; rows without verified employer ${s.rowsWithoutEmployer}; identity conflicts ${s.identityConflicts}.${rowFailureText}${haltText} Resume-safe: yes; rerunning re-reads the live sheet and preserves already populated verified values. AI/model calls: 0.`;
}

module.exports = {
  schemaLinkedInColumns,
  patchRichLinkedInLinks,
  readUniversalSheet,
  companyFromCompanyAnchor,
  resolvePersonAnchor,
  existingIdentityKeys,
  candidateAlreadyPresent,
  needsEmbeddedDesignationRepair,
  candidateFillTargets,
  existingRepairNeedsDiscovery,
  exactCandidateForExisting,
  queuePendingPhone,
  syncPendingPhoneAssignments,
  repairExistingGroups,
  candidateDiscoveryKey,
  mergeCandidatePools,
  companyPriorityTitles,
  companyPriorityCandidate,
  discoverCompanyPeople,
  fillOpenGroups,
  typedFailureSummary,
  isRecoverableRowFailure,
  isTransientProviderRowFailure,
  formatFailureSummary,
  freshStats,
  run,
  formatResult,
};
