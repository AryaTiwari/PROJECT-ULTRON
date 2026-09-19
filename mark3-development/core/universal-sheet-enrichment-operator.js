'use strict';

// Universal deterministic spreadsheet enrichment executor.
// No model/router dependency is permitted in this file.

const fs = require('fs');
const path = require('path');
const config = require('./config');
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

const PHONE_ASSIGNMENTS_FILE = path.join(config.projectRoot, '.ultron', 'lead-enrichment', 'pending-phone-assignments.json');
const backgroundPhoneAssignments = new Map();
let backgroundPhoneWatcher = null;
let backgroundPhoneWatcherRemaining = 0;
let backgroundPhoneAssignmentsLoaded = false;

function persistBackgroundPhoneAssignments() {
  try {
    fs.mkdirSync(path.dirname(PHONE_ASSIGNMENTS_FILE), { recursive: true });
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      assignments: [...backgroundPhoneAssignments.entries()].map(([key, value]) => ({ key, ...value })),
    };
    fs.writeFileSync(PHONE_ASSIGNMENTS_FILE, JSON.stringify(payload, null, 2), { mode: 0o600 });
    try { fs.chmodSync(PHONE_ASSIGNMENTS_FILE, 0o600); } catch {}
  } catch {}
}

function loadBackgroundPhoneAssignments() {
  if (backgroundPhoneAssignmentsLoaded) return backgroundPhoneAssignments.size;
  backgroundPhoneAssignmentsLoaded = true;
  try {
    if (!fs.existsSync(PHONE_ASSIGNMENTS_FILE)) return 0;
    const parsed = JSON.parse(fs.readFileSync(PHONE_ASSIGNMENTS_FILE, 'utf8'));
    for (const item of Array.isArray(parsed?.assignments) ? parsed.assignments : []) {
      const key = text(item?.key);
      if (!key || !item?.spreadsheetId || !item?.sheetName || !Number.isInteger(Number(item?.rowNumber)) || !Number.isInteger(Number(item?.columnIndex)) || !item?.apolloPersonId) continue;
      const { key: _ignored, ...value } = item;
      backgroundPhoneAssignments.set(key, value);
    }
  } catch {}
  return backgroundPhoneAssignments.size;
}
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


const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com','googlemail.com','yahoo.com','yahoo.co.in','outlook.com','hotmail.com','live.com',
  'icloud.com','me.com','proton.me','protonmail.com','aol.com','rediffmail.com',
]);

function cleanedCompanyEvidence(value) {
  return text(value)
    .replace(/^[\s:–—-]+|[\s:–—-]+$/g, '')
    .replace(/\s+(?:\||•).*$/s, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function contextEvidenceText(plan = {}) {
  return Object.values(plan?.context || {})
    .filter((value) => typeof value === 'string' && text(value))
    .join('\n');
}

function firstBusinessEmailDomain(value) {
  const matches = String(value || '').match(/[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/ig) || [];
  for (let i = matches.length - 1; i >= 0; i--) {
    const domain = websiteDomain(String(matches[i]).split('@').pop() || '');
    if (domain && !FREE_EMAIL_DOMAINS.has(domain)) return domain;
  }
  return '';
}

function inferHiringCompanyFromEvidence(plan, row = []) {
  const evidence = contextEvidenceText(plan);
  if (!evidence) return null;

  const patterns = [
    { source: 'row-join-company', confidence: 0.98, regex: /\bjoin\s+([A-Z][A-Za-z0-9&.'’()\- ]{2,100}?)\s+as\b/i },
    { source: 'row-company-is-hiring', confidence: 0.97, regex: /(?:^|\n)\s*([A-Z][A-Za-z0-9&.'’()\- ]{2,100}?)\s+(?:is|are)\s+(?:looking|hiring|seeking)\b/i },
    { source: 'row-headline-employer', confidence: 0.96, regex: /\b(?:founder|co[- ]?founder|owner|director|business director|managing director|manager|recruiter|talent acquisition specialist|talent acquisition lead|human resources manager|hr recruiter)\s+(?:at|@)\s+([^\n|•]{2,100})/i },
    { source: 'row-with-company', confidence: 0.94, regex: /(?:^|\n)\s*with\s+([^\n|•]{2,100}?)(?:\s*•|\s*$)/im },
  ];

  for (const rule of patterns) {
    const match = evidence.match(rule.regex);
    const company = cleanedCompanyEvidence(match?.[1] || '');
    if (!company) continue;
    return {
      company,
      domain: '',
      source: rule.source,
      evidenceConfidence: rule.confidence,
      anchorLinkedin: text(plan?.anchor?.snapshot?.values?.linkedin),
      anchorApolloPersonId: '',
      anchorPerson: null,
    };
  }

  const domain = firstBusinessEmailDomain(evidence);
  if (domain) {
    return {
      company: domain,
      domain,
      source: 'row-business-email-domain',
      evidenceConfidence: 0.93,
      anchorLinkedin: text(plan?.anchor?.snapshot?.values?.linkedin),
      anchorApolloPersonId: '',
      anchorPerson: null,
    };
  }

  return null;
}

function preferredHiringCompanyContext(plan, row, anchorContext = null) {
  return inferHiringCompanyFromEvidence(plan, row) || anchorContext;
}

function anchorNeedsHydration(plan = {}) {
  const anchor = plan?.anchor;
  if (!anchor || anchor.type !== 'person') return false;
  const values = anchor.snapshot?.values || {};
  const fields = anchor.group?.fields || {};
  if (fields.phone && !text(values.phone)) return true;
  if (fields.email && !text(values.email)) return true;
  if (fields.role && !text(values.role)) return true;
  return false;
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

  if (!company) return {
    unresolved: true,
    anchorProfile: profile,
    anchorPerson: profile && profile.noMatch !== true && profile.ambiguous !== true && profile.identityVerified !== false
      ? { ...profile, linkedinUrl: normalizedLinkedin || profile.linkedinUrl || '', identityVerified: true }
      : null,
    anchorLinkedin: normalizedLinkedin || '',
  };
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


function backgroundPhoneKey(source, item) {
  return `${source.spreadsheetId}|${source.sheetName}|${item.rowNumber}|${item.columnIndex}|${item.apolloPersonId}`;
}

function registerBackgroundPhoneAssignments(source, items = []) {
  for (const item of items) {
    if (!item?.apolloPersonId) continue;
    const key = backgroundPhoneKey(source, item);
    backgroundPhoneAssignments.set(key, {
      ...item,
      spreadsheetId: source.spreadsheetId,
      sheetName: source.sheetName,
      registeredAt: new Date().toISOString(),
    });
  }
  persistBackgroundPhoneAssignments();
  return backgroundPhoneAssignments.size;
}

async function syncBackgroundPhoneAssignments() {
  loadBackgroundPhoneAssignments();
  if (!backgroundPhoneAssignments.size) return { resolved: 0, pending: 0 };
  const results = await apollo.fetchPhoneResults();
  if (!Array.isArray(results) || !results.length) {
    return { resolved: 0, pending: backgroundPhoneAssignments.size };
  }

  const byId = new Map();
  for (const result of results) {
    const id = text(result?.apollo_person_id);
    if (id) byId.set(id, result);
  }

  let resolved = 0;
  let written = 0;
  const handledIds = new Set();
  for (const [key, item] of [...backgroundPhoneAssignments.entries()]) {
    const result = byId.get(item.apolloPersonId);
    if (!result) continue;
    const phone = apollo.validPhone(result?.phone);
    apollo.recordPhoneResult(item.apolloPersonId, phone);
    handledIds.add(item.apolloPersonId);

    try {
      const range = sheets.cellRange(item.sheetName, item.rowNumber, item.columnIndex);
      const current = await sheets.readCell(item.spreadsheetId, range);
      if (phone && sheets.isBlank(current)) {
        await sheets.writeCells(item.spreadsheetId, [{ range, value: phone }]);
        written++;
      }
      backgroundPhoneAssignments.delete(key);
      resolved++;
    } catch (error) {
      item.lastError = text(error?.message || error).slice(0, 300);
      item.lastAttemptAt = new Date().toISOString();
      backgroundPhoneAssignments.set(key, item);
    }
  }

  for (const id of handledIds) {
    const stillPendingForId = [...backgroundPhoneAssignments.values()]
      .some((item) => item.apolloPersonId === id);
    if (!stillPendingForId) {
      try { await apollo.consumePhoneResult(id); } catch {}
    }
  }

  persistBackgroundPhoneAssignments();
  return { resolved, written, pending: backgroundPhoneAssignments.size };
}

function startBackgroundPhoneWatcher() {
  loadBackgroundPhoneAssignments();
  if (backgroundPhoneWatcher || !backgroundPhoneAssignments.size) return;
  backgroundPhoneWatcherRemaining = Math.max(
    1,
    Math.min(60, Number(process.env.ULTRON_M3_APOLLO_PHONE_WATCHER_ATTEMPTS || 30)),
  );

  const tick = async () => {
    backgroundPhoneWatcher = null;
    if (!backgroundPhoneAssignments.size || backgroundPhoneWatcherRemaining-- <= 0) return;
    try { await syncBackgroundPhoneAssignments(); } catch {}
    if (backgroundPhoneAssignments.size && backgroundPhoneWatcherRemaining > 0) {
      const delay = Math.max(
        5000,
        Math.min(120000, Number(process.env.ULTRON_M3_APOLLO_PHONE_WATCHER_INTERVAL_MS || 45000)),
      );
      backgroundPhoneWatcher = setTimeout(tick, delay);
      backgroundPhoneWatcher.unref?.();
    }
  };

  const firstDelay = Math.max(
    1000,
    Math.min(60000, Number(process.env.ULTRON_M3_APOLLO_PHONE_WATCHER_FIRST_MS || 15000)),
  );
  backgroundPhoneWatcher = setTimeout(tick, firstDelay);
  backgroundPhoneWatcher.unref?.();
}

function backgroundPhoneStatus() {
  return {
    pending: backgroundPhoneAssignments.size,
    watcherActive: Boolean(backgroundPhoneWatcher),
    attemptsRemaining: backgroundPhoneWatcherRemaining,
  };
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
  if (unresolved.size && options.backgroundPhoneWatcher !== false) {
    stats.backgroundPhonePending = registerBackgroundPhoneAssignments(source, [...unresolved.values()]);
    startBackgroundPhoneWatcher();
    stats.backgroundPhoneWatcher = true;
  }
}

function existingPersonVerificationContext(item, fallbackContext = {}) {
  const snapshot = item?.snapshot || {};
  const emailDomain = firstBusinessEmailDomain(snapshot?.values?.email || '');
  if (emailDomain) {
    return {
      ...fallbackContext,
      company: fallbackContext?.company || emailDomain,
      domain: emailDomain,
      source: 'existing-poc-business-email-domain',
    };
  }
  return fallbackContext;
}

async function repairExistingGroups(row, plan, companyContext, stats, options = {}) {
  const writes = [];
  const targets = new Map();
  for (const item of plan.groups?.partial || []) if (!item.isAnchor) targets.set(item.group.id, item);
  for (const item of plan.groups?.existing || []) {
    if (needsEmbeddedDesignationRepair(item)) targets.set(item.group.id, item);
  }

  for (const item of targets.values()) {
    const group = item.group;
    const snapshot = item.snapshot;
    if (!snapshot.hasIdentity) continue;
    const needEmail = Boolean(group.fields.email && !snapshot.values.email);
    const needPhone = Boolean(group.fields.phone && !snapshot.values.phone);
    const verificationContext = existingPersonVerificationContext(item, companyContext);
    let resolved = null;
    let verificationPath = '';
    stats.existingVerificationAttempts++;

    try {
      if (snapshot.linkedinKind === 'linkedin_person') {
        verificationPath = 'exact-linkedin';
        resolved = await apollo.resolvePersonProfile(snapshot.values.linkedin, { needEmail, needPhone });
      } else if (snapshot.values.name && (verificationContext.company || verificationContext.domain)) {
        verificationPath = 'apollo-name-company';
        resolved = await apollo.resolvePersonByNameCompany(
          snapshot.values.name,
          verificationContext.company,
          verificationContext.domain,
          { needEmail, needPhone },
        );
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

    if (!resolved || resolved.noMatch || resolved.ambiguous || resolved.identityVerified === false || !ranker.sameEmployer(resolved, verificationContext)) {
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


function companyBrandFromDomain(value) {
  const host = websiteDomain(value);
  if (!host) return '';
  const label = host.split('.')[0] || '';
  return label.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function collectLinkedInPersonUrls(value, out = new Set()) {
  if (value == null) return out;
  if (typeof value === 'string') {
    const raw = value;
    for (const match of raw.matchAll(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9%._~-]+\/?/gi)) {
      const normalized = apollo.normalizeLinkedIn(match[0]);
      if (normalized) out.add(normalized);
    }
    for (const match of raw.matchAll(/(?:^|[\s"'(])\/in\/([A-Za-z0-9%._~-]+)\/?/gi)) {
      const normalized = apollo.normalizeLinkedIn(`https://www.linkedin.com/in/${match[1]}`);
      if (normalized) out.add(normalized);
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectLinkedInPersonUrls(item, out);
    return out;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) collectLinkedInPersonUrls(item, out);
  }
  return out;
}

function linkedinZeroResultFallbackEnabled(options = {}) {
  if (options.linkedinZeroResultFallback === false) return false;
  return !/^(0|false|no|off)$/i.test(String(process.env.ULTRON_M3_UNIVERSAL_LINKEDIN_ZERO_RESULT_FALLBACK ?? '1').trim());
}

async function discoverLinkedInFallbackPeople(companyContext, stats, options = {}) {
  if (!linkedinZeroResultFallbackEnabled(options)) return [];
  const company = text(companyContext?.company);
  const domain = websiteDomain(companyContext?.domain || '');
  const brand = company && !company.includes('.') ? company : companyBrandFromDomain(domain || company);
  const queryBrand = cleanedCompanyEvidence(brand || company || domain);
  if (!queryBrand) return [];

  const keywords = `${queryBrand} recruiter talent acquisition HR director founder`;
  let result = null;
  try {
    result = await linkedinMcp.callTool('search_people', {
      keywords,
      ...(options.location ? { location: String(options.location) } : {}),
    });
    stats.linkedinFallbackSearches = Number(stats.linkedinFallbackSearches || 0) + 1;
  } catch (error) {
    stats.linkedinFallbackFailures = Number(stats.linkedinFallbackFailures || 0) + 1;
    stats.discoveryDiagnostics.push({
      company: queryBrand,
      code: String(error?.code || 'LINKEDIN_ZERO_RESULT_SEARCH_FAILED'),
      message: String(error?.message || error || '').slice(0, 300),
    });
    return [];
  }

  const urls = [...collectLinkedInPersonUrls(result)];
  stats.linkedinFallbackProfilesFound = Number(stats.linkedinFallbackProfilesFound || 0) + urls.length;
  if (!urls.length) return [];

  const limit = integer(
    options.linkedinFallbackVerifyLimit ?? process.env.ULTRON_M3_UNIVERSAL_LINKEDIN_FALLBACK_VERIFY_LIMIT,
    6,
    1,
    10,
  );

  const verified = [];
  for (const linkedinUrl of urls.slice(0, limit)) {
    try {
      const person = await apollo.resolvePersonProfile(linkedinUrl, { needEmail: false, needPhone: false });
      if (
        !person
        || person.noMatch
        || person.ambiguous
        || person.identityVerified === false
        || !person.title
        || !ranker.sameEmployer(person, companyContext)
      ) continue;
      verified.push({
        id: text(person.apolloPersonId || person.id) || null,
        apolloPersonId: text(person.apolloPersonId || person.id) || null,
        name: text(person.name),
        title: text(person.title),
        headline: text(person.headline),
        linkedinUrl,
        organizationName: text(person.organizationName || person.organization?.name),
        organizationDomain: websiteDomain(person.organizationDomain || person.organization?.website_url || ''),
        seniority: text(person.seniority),
        departments: Array.isArray(person.departments) ? person.departments : [],
        functions: Array.isArray(person.functions) ? person.functions : [],
        linkedinFallback: true,
      });
    } catch {}
  }

  stats.linkedinFallbackVerifiedCandidates = Number(stats.linkedinFallbackVerifiedCandidates || 0) + verified.length;
  return verified;
}

async function discoverPriorityPeopleFast(companyContext, cache, stats, options = {}) {
  const company = text(companyContext?.company);
  const domain = websiteDomain(companyContext?.domain || '');
  const key = `priority-fast-v2|${ranker.companyKey(company)}|${domain}|${ranker.normalize(options.location || '')}`;
  if (cache.has(key)) {
    stats.candidateCacheHits++;
    return cache.get(key);
  }

  const merged = [];
  const add = (people) => {
    const combined = mergeCandidatePools(merged, people);
    merged.length = 0;
    merged.push(...combined);
  };
  const priorityLimit = integer(options.priorityCandidateLimit, 20, 6, 40);
  const broadLimit = integer(options.adaptiveBroadCandidateLimit, 30, 10, 50);

  // 1. Fast canonical title search against the strongest known organization identity.
  try {
    const priority = await apollo.searchCompanyPeopleBroad({
      company,
      domain,
      location: options.location || '',
      limit: priorityLimit,
      titles: companyPriorityTitles(),
    });
    stats.candidateSearches++;
    stats.candidatePrioritySearches++;
    add(Array.isArray(priority?.people) ? priority.people : []);
  } catch (error) {
    stats.candidatePrioritySearchFailures++;
    stats.discoveryDiagnostics.push({
      company: company || domain,
      code: String(error?.code || 'APOLLO_PRIORITY_FAST_SEARCH_FAILED'),
      message: String(error?.message || error || '').slice(0, 300),
    });
  }

  // 2. If title-targeting produced nothing, do one bounded broad search.
  if (!merged.length) {
    try {
      const broad = await apollo.searchCompanyPeopleBroad({
        company,
        domain,
        location: options.location || '',
        limit: broadLimit,
        titles: [],
      });
      stats.candidateSearches++;
      stats.candidateBroadSearches++;
      add(Array.isArray(broad?.people) ? broad.people : []);
    } catch (error) {
      stats.discoveryDiagnostics.push({
        company: company || domain,
        code: String(error?.code || 'APOLLO_ADAPTIVE_BROAD_SEARCH_FAILED'),
        message: String(error?.message || error || '').slice(0, 300),
      });
    }
  }

  // 3. Apollo sometimes has the organization but not under the supplied domain.
  // Retry once by human-readable brand keyword rather than repeating the same
  // empty domain filter. Example: people-click.com -> "people click".
  if (!merged.length && domain) {
    const brand = companyBrandFromDomain(domain);
    if (brand && ranker.companyKey(brand) !== ranker.companyKey(company)) {
      try {
        const keyword = await apollo.searchCompanyPeopleBroad({
          company: brand,
          domain: '',
          location: options.location || '',
          limit: broadLimit,
          titles: [],
        });
        stats.candidateSearches++;
        stats.candidateBroadSearches++;
        add(Array.isArray(keyword?.people) ? keyword.people : []);
      } catch (error) {
        stats.discoveryDiagnostics.push({
          company: brand,
          code: String(error?.code || 'APOLLO_BRAND_KEYWORD_SEARCH_FAILED'),
          message: String(error?.message || error || '').slice(0, 300),
        });
      }
    }
  }

  // 4. If company itself is just a domain string, also retry its readable brand.
  if (!merged.length && company && websiteDomain(company) === company.toLowerCase()) {
    const brand = companyBrandFromDomain(company);
    if (brand) {
      try {
        const keyword = await apollo.searchCompanyPeopleBroad({
          company: brand,
          domain: '',
          location: options.location || '',
          limit: broadLimit,
          titles: companyPriorityTitles(),
        });
        stats.candidateSearches++;
        stats.candidatePrioritySearches++;
        add(Array.isArray(keyword?.people) ? keyword.people : []);
      } catch (error) {
        stats.candidatePrioritySearchFailures++;
        stats.discoveryDiagnostics.push({
          company: brand,
          code: String(error?.code || 'APOLLO_BRAND_PRIORITY_SEARCH_FAILED'),
          message: String(error?.message || error || '').slice(0, 300),
        });
      }
    }
  }

  // 5. True zero-result fallback: one authenticated read-only LinkedIn people
  // search. LinkedIn only supplies profile references; Apollo still owns exact
  // identity/employer verification before these candidates can be selected.
  if (!merged.length && linkedinZeroResultFallbackEnabled(options)) {
    const linkedinPeople = await discoverLinkedInFallbackPeople(companyContext, stats, options);
    add(linkedinPeople);
  }

  stats.candidatesDiscovered += merged.length;
  cache.set(key, merged);
  return merged;
}

function manualPriorityCandidates(candidates = [], companyContext = {}, existing = { names: new Set(), linkedins: new Set() }) {
  const rows = [];
  for (const candidate of candidates || []) {
    if (!candidate || !ranker.sameEmployer(candidate, companyContext)) continue;
    if (candidateAlreadyPresent(candidate, existing)) continue;
    const priority = Number(apollo.decisionPriority(candidate.title || candidate.headline || ''));
    if (priority >= 99) continue;
    const scored = ranker.scoreCandidate(candidate, {
      company: companyContext.company,
      companyDomain: companyContext.domain,
    }, candidates || []);
    rows.push({ candidate, priority, score: Number(scored?.score || 0) });
  }
  return rows
    .sort((a, b) => a.priority - b.priority || b.score - a.score || String(a.candidate?.name || '').localeCompare(String(b.candidate?.name || '')))
    .map((item) => item.candidate);
}

async function fillManualPriorityGroup(row, plan, companyContext, candidates, stats, options = {}) {
  const ordinal = Number(options.ordinal || 0);
  if (!ordinal) return { writes: [], filled: false, selected: null };
  const target = candidateFillTargets(plan).find((item) => Number(item.group?.ordinal || 0) === ordinal);
  if (!target) return { writes: [], filled: false, selected: null };

  const existing = existingIdentityKeys(plan);
  const claimed = options.claimed instanceof Set ? options.claimed : new Set();
  const priorityPool = manualPriorityCandidates(candidates, companyContext, existing)
    .filter((candidate) => {
      const key = candidateDiscoveryKey(candidate);
      return key && !claimed.has(key);
    });

  // If the canonical title ladder has no candidate, append the strongest
  // deterministic evidence-ranked candidates. This keeps functional hiring
  // authorities available without making the common path expensive.
  const fallbackRanking = ranker.rankCandidates(
    (candidates || []).filter((candidate) => !candidateAlreadyPresent(candidate, existing)),
    {
      ...plan.context,
      company: companyContext.company,
      companyDomain: companyContext.domain,
      anchorApolloPersonId: companyContext.anchorApolloPersonId,
      anchorLinkedin: companyContext.anchorLinkedin,
    },
    { minimumScore: Number(options.fallbackMinimumScore ?? 28) },
  ).ranked.map((item) => item.candidate);

  const pool = mergeCandidatePools(priorityPool, fallbackRanking)
    .filter((candidate) => {
      const key = candidateDiscoveryKey(candidate);
      return key && !claimed.has(key);
    });

  const maxAttempts = integer(options.maxHydrationAttempts, ordinal === 2 ? 3 : 1, 1, 5);
  for (let attempt = 0; attempt < Math.min(maxAttempts, pool.length); attempt++) {
    const raw = pool[attempt];
    const rawKey = candidateDiscoveryKey(raw);
    stats.hydrationAttempts++;
    let person = null;
    try {
      person = await apollo.resolveDecisionMaker(raw, companyContext.company, companyContext.domain, {
        needEmail: Boolean(target.group.fields.email),
        needPhone: Boolean(target.group.fields.phone),
      });
    } catch {
      stats.hydrationFailures++;
      claimed.add(rawKey);
      continue;
    }

    if (!person?.identityVerified || !person?.title || !ranker.sameEmployer(person, companyContext)) {
      stats.hydrationFailures++;
      claimed.add(rawKey);
      continue;
    }

    const hydratedName = ranker.normalize(person.name || '');
    const hydratedLinkedin = ranker.linkedinKey(person.linkedinUrl || person.returnedLinkedIn || '');
    if ((hydratedName && existing.names.has(hydratedName)) || (hydratedLinkedin && existing.linkedins.has(hydratedLinkedin))) {
      stats.postHydrationDuplicates++;
      claimed.add(rawKey);
      continue;
    }

    queuePendingPhone(options, Number(options.rowNumber), target.group, target.snapshot, person);
    const writePlan = planner.safeWritesForGroup(row, target.group, person);
    if (!writePlan.allowed || (!writePlan.writes.length && person.phoneStatus !== 'pending')) {
      stats.identityConflicts++;
      claimed.add(rawKey);
      continue;
    }

    claimed.add(rawKey);
    if (hydratedName) existing.names.add(hydratedName);
    if (hydratedLinkedin) existing.linkedins.add(hydratedLinkedin);
    stats.newPeopleSelected++;
    stats.embeddedDesignationWrites += writePlan.writes.filter((write) => write.embeddedRole).length;
    stats.selectionAudit.push({
      groupId: target.group.id,
      ordinal,
      strategy: 'manual-priority',
      priority: apollo.decisionPriority(person.title || raw.title || ''),
      apolloPersonId: text(person.apolloPersonId || person.id),
      name: person.name || '',
      title: person.title || '',
      fields: writePlan.writes.map((write) => write.field),
    });
    return { writes: writePlan.writes, filled: true, selected: person };
  }

  return { writes: [], filled: false, selected: null };
}

async function fillOpenGroups(row, plan, companyContext, candidates, stats, options = {}) {
  const allowedOrdinals = Array.isArray(options.targetOrdinals)
    ? new Set(options.targetOrdinals.map((value) => Number(value)).filter(Number.isFinite))
    : null;
  const targets = candidateFillTargets(plan).filter((target) =>
    !allowedOrdinals || allowedOrdinals.has(Number(target.group?.ordinal || 0))
  );
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
      const ordinal = Number(target.group?.ordinal || 0);
      const ordinalConfidence = ordinal === 2
        ? Number(options.poc2MinimumConfidence ?? options.minimumConfidence ?? 0.48)
        : ordinal >= 3
          ? Number(options.poc3MinimumConfidence ?? 0.66)
          : Number(options.minimumConfidence ?? 0.54);
      if (selection.confidence < ordinalConfidence) {
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

async function applyRecoveredHeaderRepairs(source, stats) {
  const repairs = Array.isArray(source?.schema?.headerRepairs) ? source.schema.headerRepairs : [];
  stats.headerRepairsPlanned = repairs.length;
  if (!repairs.length) return [];

  const changes = [];
  for (const repair of repairs) {
    if (!Number.isInteger(repair?.columnIndex) || !Number.isInteger(repair?.rowNumber)) continue;
    const range = sheets.cellRange(source.sheetName, repair.rowNumber, repair.columnIndex);
    let current = '';
    try { current = await sheets.readCell(source.spreadsheetId, range); } catch (error) {
      error.stage = error.stage || 'schema-continuity-header-read';
      throw error;
    }
    if (!sheets.isBlank(current)) {
      stats.headerRepairsSkippedPopulated++;
      continue;
    }
    changes.push({ range, value: repair.value, rowNumber: repair.rowNumber, columnIndex: repair.columnIndex });
  }

  if (!changes.length) return [];
  try {
    await sheets.writeCells(source.spreadsheetId, changes);
  } catch (error) {
    error.stage = error.stage || 'schema-continuity-header-write';
    throw error;
  }

  for (const change of changes) {
    const rowIndex = change.rowNumber - 1;
    if (!source.rows[rowIndex]) source.rows[rowIndex] = [];
    source.rows[rowIndex][change.columnIndex] = change.value;
  }
  stats.headerRepairsWritten += changes.length;
  return changes;
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
    rowEvidenceEmployersResolved: 0,
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
    linkedinFallbackSearches: 0,
    linkedinFallbackFailures: 0,
    linkedinFallbackProfilesFound: 0,
    linkedinFallbackVerifiedCandidates: 0,
    postHydrationDuplicates: 0,
    discoveryDiagnostics: [],
    pendingPhoneRequests: 0,
    resumedPhoneAssignments: 0,
    resumedPhoneResolved: 0,
    resumedPhoneCellsFilled: 0,
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
    deferredOpenGroups: 0,
    deferredPoc2Rows: [],
    manualPoc2Attempts: 0,
    manualPoc2Filled: 0,
    manualPoc3Attempts: 0,
    manualPoc3Filled: 0,
    optionalPoc3Deferred: 0,
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
    headerRepairsPlanned: 0,
    headerRepairsWritten: 0,
    headerRepairsSkippedPopulated: 0,
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

  const stats = freshStats();

  // Resume Apollo phone callbacks from earlier runs/restarts before doing new
  // enrichment work. Ownership is persisted by exact sheet/row/column/person id.
  stats.resumedPhoneAssignments = loadBackgroundPhoneAssignments();
  if (backgroundPhoneAssignments.size) {
    try {
      const replay = await syncBackgroundPhoneAssignments();
      stats.resumedPhoneResolved = Number(replay?.resolved || 0);
      stats.resumedPhoneCellsFilled = Number(replay?.written || 0);
      stats.phoneCellsFilled += stats.resumedPhoneCellsFilled;
      stats.cellsChanged += stats.resumedPhoneCellsFilled;
    } catch {}
    if (backgroundPhoneAssignments.size) startBackgroundPhoneWatcher();
  }

  // Persist continuity-recovered headers only after the approved run begins and
  // only into cells that are still blank. This makes the restored contact layout
  // self-describing for later runs without risking overwrite of user data.
  await applyRecoveredHeaderRepairs(source, stats);

  // These wrappers are installed by the deterministic bootstrap, but their
  // accounting/budgets are per approved enrichment run, not process-lifetime.
  try { require('./apollo-three-poc-quality').startRun(); } catch {}
  try { require('./three-poc-candidate-discovery-policy').startRun(); } catch {}
  const cache = options.discoveryCache instanceof Map ? options.discoveryCache : new Map();
  const pendingPhoneQueue = [];
  const runOptions = { ...options, discoveryCache: cache, pendingPhoneQueue };
  for (const record of analysis.rowPlans) {
    stats.rowsSeen++;
    const { row, rowNumber, plan } = record;
    if (!plan.anchor) { stats.rowsWithoutAnchor++; continue; }

    try {
      const rowEvidenceContext = inferHiringCompanyFromEvidence(plan, row);
      let anchorCompanyContext = null;
      if (plan.anchor.type === 'company') {
        anchorCompanyContext = companyFromCompanyAnchor(plan.anchor);
      } else if (anchorNeedsHydration(plan) || !rowEvidenceContext) {
        anchorCompanyContext = await resolvePersonAnchor(plan, row, { ...options, allowLinkedInEmployerFallback: false });
      } else {
        anchorCompanyContext = {
          unresolved: true,
          source: 'anchor-hydration-skipped-complete',
          anchorLinkedin: apollo.normalizeLinkedIn(plan.anchor?.snapshot?.values?.linkedin || ''),
          anchorPerson: null,
        };
      }

      let companyContext = rowEvidenceContext
        || (anchorCompanyContext && !anchorCompanyContext.unresolved && anchorCompanyContext.company ? anchorCompanyContext : null);

      // LinkedIn employer scraping is the slow fallback, never the default. Use it
      // only when neither row evidence nor Apollo's exact anchor profile resolved
      // a usable hiring organization.
      if (!companyContext?.company && plan.anchor.type === 'person') {
        try {
          const linkedinEmployerContext = await resolvePersonAnchor(plan, row, { ...options, allowLinkedInEmployerFallback: true });
          if (linkedinEmployerContext?.company) companyContext = linkedinEmployerContext;
          if (!anchorCompanyContext?.anchorPerson && linkedinEmployerContext?.anchorPerson) {
            anchorCompanyContext = linkedinEmployerContext;
          }
        } catch {}
      }

      if (companyContext?.source && /^row-/.test(companyContext.source)) stats.rowEvidenceEmployersResolved++;
      const writes = [];
      const fillTargets = candidateFillTargets(plan);
      const aiFallbackEnabled = Boolean(options.deferOpenGroupSelectionToAi);

      // POC-1 is non-negotiable and remains tied to the exact anchor identity.
      // POC-2/3 may target a different explicit hiring organization from the post.
      const anchorContext = anchorCompanyContext?.anchorPerson
        ? anchorCompanyContext
        : { ...(anchorCompanyContext || {}), anchorPerson: anchorCompanyContext?.anchorProfile || null };
      const earlyRowOptions = { ...runOptions, rowNumber, candidatePool: [] };
      writes.push(...await enrichAnchorGroup(row, plan, anchorContext, stats, earlyRowOptions));

      if (!companyContext || companyContext.unresolved || !companyContext.company) {
        stats.rowsWithoutEmployer++;
        const unresolvedPoc2 = fillTargets.some((target) => Number(target.group?.ordinal || 0) === 2);
        if (unresolvedPoc2 && aiFallbackEnabled) {
          stats.deferredOpenGroups++;
          stats.unfilledOpenGroups++;
          if (!stats.deferredPoc2Rows.includes(rowNumber)) stats.deferredPoc2Rows.push(rowNumber);
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
        continue;
      }

      stats.anchorsResolved++;

      const poc2Targets = fillTargets.filter((target) => Number(target.group?.ordinal || 0) === 2);
      const poc3Targets = fillTargets.filter((target) => Number(target.group?.ordinal || 0) >= 3);

      // Existing/partial POCs are exact-person repair jobs, not discovery jobs.
      // Verify them directly by LinkedIn or exact name+company before spending any
      // Apollo people-search calls. This is especially important for missing phones.
      const repairOptions = { ...runOptions, rowNumber, candidatePool: [] };
      writes.push(...await repairExistingGroups(row, plan, companyContext, stats, repairOptions));

      // Discovery exists for mandatory POC-2 only. POC-3 may reuse this pool for
      // one cheap attempt, but POC-3 alone must never trigger a new people search.
      let people = [];
      if (poc2Targets.length) {
        try {
          people = await discoverPriorityPeopleFast(companyContext, cache, stats, {
            ...runOptions,
            location: plan.context?.location || '',
            priorityCandidateLimit: options.manualPriorityCandidateLimit ?? 20,
          });
        } catch (error) {
          stats.candidatePrioritySearchFailures++;
          stats.discoveryDiagnostics.push({
            company: companyContext.company,
            code: String(error?.code || 'APOLLO_PRIORITY_FAST_SEARCH_FAILED'),
            message: String(error?.message || error || '').slice(0, 300),
          });
        }
      }

      const rowOptions = { ...runOptions, rowNumber, candidatePool: people };
      const manualClaimed = new Set();

      if (poc2Targets.length) {
        stats.manualPoc2Attempts += poc2Targets.length;
        const result = await fillManualPriorityGroup(row, plan, companyContext, people, stats, {
          ...rowOptions,
          ordinal: 2,
          claimed: manualClaimed,
          maxHydrationAttempts: options.poc2HydrationAttempts ?? 3,
          fallbackMinimumScore: options.poc2FallbackMinimumScore ?? 26,
        });
        writes.push(...result.writes);
        if (result.filled) stats.manualPoc2Filled++;
        else if (aiFallbackEnabled) {
          stats.deferredOpenGroups++;
          stats.unfilledOpenGroups++;
          if (!stats.deferredPoc2Rows.includes(rowNumber)) stats.deferredPoc2Rows.push(rowNumber);
        }
      }

      // POC-3 gets exactly one cheap manual hydration opportunity from the same
      // discovery pool. No extra discovery and no AI rescue unless explicitly enabled.
      if (poc3Targets.length) {
        if (people.length) {
          stats.manualPoc3Attempts += poc3Targets.length;
          const result = await fillManualPriorityGroup(row, plan, companyContext, people, stats, {
            ...rowOptions,
            ordinal: 3,
            claimed: manualClaimed,
            maxHydrationAttempts: options.poc3HydrationAttempts ?? 1,
            fallbackMinimumScore: options.poc3FallbackMinimumScore ?? 42,
          });
          writes.push(...result.writes);
          if (result.filled) stats.manualPoc3Filled++;
          else stats.optionalPoc3Deferred += poc3Targets.length;
        } else {
          stats.optionalPoc3Deferred += poc3Targets.length;
        }
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
  return `${status} Schema: header row ${schema.headerRowNumber || '?'}, ${groups} person/contact groups, ${companies} company groups, confidence ${Number(schema.confidence || 0).toFixed(2)}; ${ordinalRecovered} ordinal contact groups recovered structurally; ${(schema.continuityRecoveries || []).length} contact groups recovered by explicit schema continuity. Header continuity repair: ${s.headerRepairsWritten || 0}/${s.headerRepairsPlanned || 0} missing headers restored into blank cells, ${s.headerRepairsSkippedPopulated || 0} skipped because populated. Processed ${s.rowsProcessed}/${s.rowsSeen} rows; changed ${s.cellsChanged} contact cells across ${s.rowsChanged} data rows; resolved ${s.anchorsResolved} anchors; repaired ${s.existingGroupsRepaired} existing groups; selected ${s.newPeopleSelected} new people. Embedded verified designations in ${s.embeddedDesignationWrites || 0} contact-name writes where no dedicated role column existed. Discovery: ${s.candidatesDiscovered} unique candidates from ${s.candidateSearches} Apollo discovery calls (${s.candidateBroadSearches || 0} broad, ${s.candidatePrioritySearches || 0} priority-targeted, ${s.candidatePrioritySearchFailures || 0} supplemental failures, ${s.candidateCacheHits} cache hits); LinkedIn zero-result fallback ${s.linkedinFallbackSearches || 0} searches, ${s.linkedinFallbackProfilesFound || 0} profile refs, ${s.linkedinFallbackVerifiedCandidates || 0} Apollo-verified candidates, ${s.linkedinFallbackFailures || 0} failures; ${s.candidatesRanked} candidates passed deterministic ranking. Hydration: ${s.hydrationAttempts} attempts, ${s.hydrationFailures} failures; ${s.postHydrationDuplicates || 0} hydrated identities were already present and were skipped before trying the next candidate. Existing-contact repair: ${s.existingVerificationAttempts || 0} verification attempts, ${s.existingDiscoveryIdentityMatches || 0} exact same-company discovery matches, ${s.existingGroupsRepaired || 0} groups repaired, ${s.existingVerificationFailures || 0} verification failures. Phone completion: ${s.pendingPhoneRequests || 0} async Apollo phone requests tracked; resumed ${s.resumedPhoneAssignments || 0} persisted callback assignments from earlier runs, resolved ${s.resumedPhoneResolved || 0}, wrote ${s.resumedPhoneCellsFilled || 0} recovered phone cells; ${s.phoneCellsFilled || 0} phone cells filled after webhook sync, ${s.phoneNotFound || 0} confirmed unavailable, ${s.phoneStillPending || 0} still pending, ${s.phoneSyncErrors || 0} sync errors; background callback watcher ${s.backgroundPhoneWatcher ? 'active' : 'idle'} with ${s.backgroundPhonePending || 0} queued. Priority routing: POC-1 exact anchor completion always runs first; POC-2 manual attempts ${s.manualPoc2Attempts || 0}, manual fills ${s.manualPoc2Filled || 0}, unresolved POC-2 deferred to AI ${s.deferredOpenGroups || 0} across ${(s.deferredPoc2Rows || []).length} exact rows; optional POC-3 manual attempts ${s.manualPoc3Attempts || 0}, strong-confidence fills ${s.manualPoc3Filled || 0}, left optional ${s.optionalPoc3Deferred || 0}. Orphan-contact safety: ${s.orphanContactTargets || 0} identity-less partial targets, ${s.orphanContactVerified || 0} verified by matching existing contact data, ${s.orphanContactBlocked || 0} blocked, ${s.orphanContactMismatches || 0} candidate/contact mismatches. Unfilled target groups: ${s.unfilledOpenGroups}; rows without anchor ${s.rowsWithoutAnchor}; row-evidence employers resolved ${s.rowEvidenceEmployersResolved || 0}; rows without verified employer ${s.rowsWithoutEmployer}; identity conflicts ${s.identityConflicts}.${rowFailureText}${haltText} Resume-safe: yes; rerunning re-reads the live sheet and preserves already populated verified values. AI/model calls: 0.`;
}

module.exports = {
  schemaLinkedInColumns,
  patchRichLinkedInLinks,
  readUniversalSheet,
  companyFromCompanyAnchor,
  inferHiringCompanyFromEvidence,
  preferredHiringCompanyContext,
  anchorNeedsHydration,
  resolvePersonAnchor,
  existingIdentityKeys,
  candidateAlreadyPresent,
  existingPersonVerificationContext,
  needsEmbeddedDesignationRepair,
  candidateFillTargets,

  queuePendingPhone,
  registerBackgroundPhoneAssignments,
  syncBackgroundPhoneAssignments,
  startBackgroundPhoneWatcher,
  loadBackgroundPhoneAssignments,
  persistBackgroundPhoneAssignments,
  backgroundPhoneStatus,
  syncPendingPhoneAssignments,
  repairExistingGroups,
  enrichAnchorGroup,
  candidateDiscoveryKey,
  mergeCandidatePools,
  companyPriorityTitles,
  companyPriorityCandidate,
  discoverCompanyPeople,
  companyBrandFromDomain,
  collectLinkedInPersonUrls,
  discoverLinkedInFallbackPeople,
  discoverPriorityPeopleFast,
  manualPriorityCandidates,
  fillManualPriorityGroup,
  fillOpenGroups,
  applyRecoveredHeaderRepairs,
  typedFailureSummary,
  isRecoverableRowFailure,
  isTransientProviderRowFailure,
  formatFailureSummary,
  freshStats,
  run,
  formatResult,
};
