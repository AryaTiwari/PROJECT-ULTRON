'use strict';
const liveWrites = require('./universal-live-write-guard');

const sheets = require('./google-sheets-operator');
const apollo = require('./apollo-enrichment');
const linkedinMcp = require('./linkedin-mcp-client');
const engine = require('./universal-enrichment-engine');
const planner = require('./universal-enrichment-planner');
const ranker = require('./universal-authority-ranker');
const orphanPolicy = require('./universal-orphan-contact-policy');
const base = require('./universal-sheet-enrichment-operator');
const fallback = require('./universal-big-pickle-fallback');

function text(value) { return String(value ?? '').trim(); }
function integer(value, fallbackValue, min = 1, max = 100000) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallbackValue;
}
function linkedinSlug(value) {
  const normalized = apollo.normalizeLinkedIn(value);
  if (!normalized) return '';
  try { return decodeURIComponent(new URL(normalized).pathname.match(/^\/in\/([^/]+)/i)?.[1] || '').trim(); } catch { return ''; }
}

function freshStats() {
  return {
    ...base.freshStats(),
    attempted: false,
    rowsSeen: 0,
    rowsEligible: 0,
    rowsChanged: 0,
    cellsChanged: 0,
    employerFallbackAttempts: 0,
    employerFallbackSuccesses: 0,
    candidateFallbackAttempts: 0,
    candidateFallbackSelections: 0,
    candidateFallbackAbstains: 0,
    candidateSearches: 0,
    candidateCacheHits: 0,
    candidatesDiscovered: 0,
    hydrationAttempts: 0,
    hydrationFailures: 0,
    newPeopleSelected: 0,
    existingVerificationAttempts: 0,
    existingVerificationFailures: 0,
    existingDiscoveryIdentityMatches: 0,
    existingGroupsRepaired: 0,
    existingRepairAudit: [],
    embeddedDesignationWrites: 0,
    anchorFieldsFilled: 0,
    orphanContactTargets: 0,
    orphanContactVerified: 0,
    orphanContactBlocked: 0,
    identityConflicts: 0,
    pendingPhoneRequests: 0,
    phoneSyncPolls: 0,
    phoneSyncErrors: 0,
    phoneSyncLastError: null,
    phoneCellsFilled: 0,
    phoneRowsChanged: 0,
    phoneNotFound: 0,
    phoneWriteSkippedPopulated: 0,
    phoneStillPending: 0,
    unresolvedTargets: 0,
    audit: [],
    rowFailures: 0,
    recoverableRowFailures: 0,
    systemicHalts: 0,
    haltedEarly: false,
    haltAtRow: null,
    haltError: null,
    rowFailureAudit: [],
    modelCalls: 0,
  };
}

async function employerFallback(plan, options, stats) {
  const anchor = plan?.anchor;
  if (!anchor || anchor.type !== 'person') return null;
  const values = anchor.snapshot?.values || {};
  const linkedin = apollo.normalizeLinkedIn(values.linkedin || '');
  const slug = linkedinSlug(linkedin);
  if (!slug) return null;
  stats.employerFallbackAttempts++;
  let raw = null;
  try {
    raw = await linkedinMcp.callTool('get_person_profile', {
      linkedin_username: slug,
      sections: 'main_profile,experience',
      max_scrolls: integer(options.linkedinMaxScrolls, 3, 1, 6),
    });
  } catch {
    return null;
  }
  const resolved = await fallback.resolveEmployerFromEvidence({
    rawProfile: raw,
    anchorName: values.name || '',
    linkedinUrl: linkedin,
  });
  if (!resolved?.company) return null;
  stats.employerFallbackSuccesses++;
  return {
    company: resolved.company,
    domain: '',
    source: resolved.source,
    anchorLinkedin: linkedin,
    anchorApolloPersonId: '',
    anchorPerson: null,
    fallbackModel: resolved.model,
  };
}

async function companyContextFor(plan, row, options, stats) {
  const rowEvidence = base.inferHiringCompanyFromEvidence(plan, row);
  if (rowEvidence?.company || rowEvidence?.domain) return rowEvidence;

  let anchorContext = null;
  if (plan.anchor?.type === 'company') {
    anchorContext = base.companyFromCompanyAnchor(plan.anchor);
  } else {
    try { anchorContext = await base.resolvePersonAnchor(plan, row, { ...options, allowLinkedInEmployerFallback: false }); } catch {}
  }
  if (anchorContext && !anchorContext.unresolved && (anchorContext.company || anchorContext.domain)) return anchorContext;

  return employerFallback(plan, options, stats);
}

function existingKeys(plan) {
  return base.existingIdentityKeys(plan);
}

function candidateAlreadyPresent(candidate, existing) {
  return base.candidateAlreadyPresent(candidate, existing);
}

function needsExistingRepair(plan) {
  if ((plan?.groups?.partial || []).some((item) => !item.isAnchor && item.snapshot?.hasIdentity)) return true;
  return (plan?.groups?.existing || []).some((item) => base.needsEmbeddedDesignationRepair(item));
}

async function hydrateSelection(selection, companyContext, target, stats) {
  const raw = selection?.candidate;
  if (!raw) return null;
  stats.hydrationAttempts++;
  let person = null;
  try {
    person = await base.hydrateDecisionMakerVerified(raw, companyContext, stats, {
      needEmail: Boolean(target.group.fields.email),
      needPhone: Boolean(target.group.fields.phone),
    });
  } catch {}
  if (!person?.identityVerified || !person?.title || !ranker.sameEmployer(person, companyContext)) {
    stats.hydrationFailures++;
    return null;
  }
  return person;
}

async function run(request = {}, primaryResult = {}, options = {}) {
  const stats = freshStats();
  const pendingPhoneQueue = [];
  const runOptions = { ...options, pendingPhoneQueue };
  fallback.resetRun();
  if (!fallback.enabled()) return { ...stats, enabled: false, fallback: fallback.snapshot() };

  const unresolvedPrimary = Number(primaryResult?.stats?.unfilledOpenGroups || 0)
    + Number(primaryResult?.stats?.rowsWithoutEmployer || 0)
    + Number(primaryResult?.stats?.existingVerificationFailures || 0);
  if (unresolvedPrimary <= 0) return { ...stats, enabled: true, fallback: fallback.snapshot() };
  stats.attempted = true;

  // Re-read after the deterministic pass so fallback never works from stale rows.
  const source = await base.readUniversalSheet(request.sheetUrl || request.url, {
    ...options,
    sheetName: request.sheetName || options.sheetName,
  });
  const analysis = engine.analyzeSheet(source.rows, { rowLimit: options.rowLimit, schema: options.schema });
  const cache = options.discoveryCache instanceof Map ? options.discoveryCache : new Map();
  const targetRows = Array.isArray(runOptions.targetRows)
    ? new Set(runOptions.targetRows.map((value) => Number(value)).filter(Number.isInteger))
    : null;

  for (const record of analysis.rowPlans) {
    stats.rowsSeen++;
    const { row, rowNumber, plan } = record;
    if (targetRows && !targetRows.has(Number(rowNumber))) continue;
    if (!plan.anchor) continue;
    const allowedOrdinals = Array.isArray(runOptions.targetOrdinals)
      ? new Set(runOptions.targetOrdinals.map((value) => Number(value)).filter(Number.isFinite))
      : null;
    const targets = base.candidateFillTargets(plan).filter((target) =>
      !allowedOrdinals || allowedOrdinals.has(Number(target.group?.ordinal || 0))
    );
    const repairEligible = needsExistingRepair(plan) && (
      !allowedOrdinals
      || (plan.groups?.partial || []).some((item) =>
        allowedOrdinals.has(Number(item.group?.ordinal || 0))
        && item.snapshot?.hasIdentity
      )
    );
    if (!targets.length && !repairEligible) continue;
    stats.rowsEligible++;

    try {
      const companyContext = await companyContextFor(plan, row, runOptions, stats);
      if (!companyContext?.company) {
        stats.unresolvedTargets += targets.length + (repairEligible ? 1 : 0);
        stats.unresolvedRows = stats.unresolvedRows || [];
        stats.unresolvedReasons = stats.unresolvedReasons || [];
        if (!stats.unresolvedRows.includes(rowNumber)) stats.unresolvedRows.push(rowNumber);
        stats.unresolvedReasons.push({ rowNumber, reason: 'employer-unresolved-after-last-resort' });
        continue;
      }

      const writes = [];

    // A fallback-resolved employer is useful for more than brand-new contacts.
    // Re-run the deterministic same-person repair logic against the newly verified
    // employer context so bare names/designations and missing contact fields can be
    // repaired without giving Big Pickle any write authority.
    const rowOptions = { ...runOptions, rowNumber };
    writes.push(...await base.enrichAnchorGroup(row, plan, companyContext, stats, rowOptions));
    writes.push(...await base.repairExistingGroups(row, plan, companyContext, stats, rowOptions));

    if (targets.length) {
      const people = await base.discoverPriorityPeopleFast(companyContext, cache, stats, {
        ...runOptions,
        rowNumber,
        location: plan.context?.location || '',
        priorityCandidateLimit: runOptions.manualPriorityCandidateLimit ?? 20,
        adaptiveBroadCandidateLimit: runOptions.adaptiveBroadCandidateLimit ?? 30,
      });
      const existing = existingKeys(plan);
      const available = (people || []).filter((candidate) => !candidateAlreadyPresent(candidate, existing));
      const context = {
        ...plan.context,
        company: companyContext.company,
        companyDomain: companyContext.domain,
        anchorApolloPersonId: companyContext.anchorApolloPersonId,
        anchorLinkedin: companyContext.anchorLinkedin,
      };
      const ranking = ranker.rankCandidates(available, context, { minimumScore: runOptions.minimumScore });

      if (!ranking.ranked.length) {
        stats.unresolvedTargets += targets.length;
        stats.unresolvedRows = stats.unresolvedRows || [];
        stats.unresolvedReasons = stats.unresolvedReasons || [];
        if (!stats.unresolvedRows.includes(rowNumber)) stats.unresolvedRows.push(rowNumber);
        stats.unresolvedReasons.push({ rowNumber, reason: 'no-verified-candidates-after-last-resort' });
      } else {
        const excluded = new Set();
        for (const target of targets) {
          const orphanTarget = orphanPolicy.isOrphanContactTarget(target);
          if (orphanTarget) stats.orphanContactTargets++;
          let filled = false;
          const maxCandidateFallbackAttempts = Math.max(1, Math.min(3, Number(runOptions.maxFallbackAttemptsPerTarget || 1)));
          for (let attempt = 0; attempt < maxCandidateFallbackAttempts && !filled; attempt++) {
            stats.candidateFallbackAttempts++;
            const selection = await fallback.chooseCandidate({
              ranking,
              context,
              target,
              minimumConfidence: Number(runOptions.minimumConfidence ?? 0.54),
              excludeKeys: [...excluded],
            });
            if (!selection) {
              stats.candidateFallbackAbstains++;
              break;
            }
            const key = fallback.candidateKey(selection.candidate);
            if (key) excluded.add(key);
            const person = await hydrateSelection(selection, companyContext, target, stats);
            if (!person) continue;

            const hydratedName = ranker.normalize(person.name || '');
            const hydratedLinkedin = ranker.linkedinKey(person.linkedinUrl || person.returnedLinkedIn || '');
            if ((hydratedName && existing.names.has(hydratedName)) || (hydratedLinkedin && existing.linkedins.has(hydratedLinkedin))) continue;

            if (orphanTarget) {
              const proof = orphanPolicy.verify(target.snapshot, person);
              if (!proof.verified) continue;
              stats.orphanContactVerified++;
            }

            base.queuePendingPhone(rowOptions, rowNumber, target.group, target.snapshot, person);
            const writePlan = planner.safeWritesForGroup(row, target.group, person);
            if (!writePlan.allowed || !writePlan.writes.length) {
              stats.identityConflicts++;
              continue;
            }
            writes.push(...writePlan.writes);
            stats.embeddedDesignationWrites += writePlan.writes.filter((write) => write.embeddedRole).length;
            if (hydratedName) existing.names.add(hydratedName);
            if (hydratedLinkedin) existing.linkedins.add(hydratedLinkedin);
            stats.candidateFallbackSelections++;
            stats.newPeopleSelected++;
            stats.audit.push({
              rowNumber,
              groupId: target.group.id,
              name: person.name || '',
              title: person.title || '',
              candidateKey: key,
              deterministicScore: selection.score,
              deterministicConfidence: selection.confidence,
              fallbackConfidence: selection.fallbackConfidence,
              fallbackReason: selection.fallbackReason,
              model: selection.fallbackModel,
            });
            filled = true;
          }
          if (!filled) {
            stats.unresolvedTargets++;
            stats.unresolvedRows = stats.unresolvedRows || [];
            stats.unresolvedReasons = stats.unresolvedReasons || [];
            if (!stats.unresolvedRows.includes(rowNumber)) stats.unresolvedRows.push(rowNumber);
            stats.unresolvedReasons.push({ rowNumber, reason: 'no-verified-poc2-after-last-resort' });
            if (orphanTarget) stats.orphanContactBlocked++;
          }
        }
      }
    }

    const byColumn = new Map();
    for (const write of writes) if (!byColumn.has(write.columnIndex)) byColumn.set(write.columnIndex, write);
    const changes = [...byColumn.values()].map((write) => ({
      range: sheets.cellRange(source.sheetName, rowNumber, write.columnIndex),
      value: write.value,
    }));
      if (changes.length) {
        await liveWrites.writeVerifiedRow(source, rowNumber, row, changes);
        stats.rowsChanged++;
        stats.cellsChanged += changes.length;
      }
    } catch (error) {
      const typed = base.typedFailureSummary(error, { stage: error?.stage || 'fallback-row-enrichment' });
      stats.rowFailures++;
      stats.rowFailureAudit.push({ rowNumber, ...typed });

      // Big Pickle itself is optional. Model fallback failures never invalidate
      // deterministic work and may safely leave this row unresolved.
      const recoverable = typed.subsystem === 'BIG_PICKLE' || base.isRecoverableRowFailure(typed);
      if (recoverable) {
        stats.recoverableRowFailures++;
        stats.unresolvedTargets += targets.length + (repairEligible ? 1 : 0);
        stats.unresolvedRows = stats.unresolvedRows || [];
        stats.unresolvedReasons = stats.unresolvedReasons || [];
        if (!stats.unresolvedRows.includes(rowNumber)) stats.unresolvedRows.push(rowNumber);
        stats.unresolvedReasons.push({
          rowNumber,
          reason: 'recoverable-last-resort-failure',
          detail: typed.code,
          typed: {
            code: typed.code,
            subsystem: typed.subsystem,
            type: typed.type,
            stage: typed.stage,
            message: typed.message,
            hint: typed.hint,
          },
        });
        continue;
      }

      stats.systemicHalts++;
      stats.haltedEarly = true;
      stats.haltAtRow = rowNumber;
      stats.haltError = typed;
      stats.unresolvedRows = stats.unresolvedRows || [];
      stats.unresolvedReasons = stats.unresolvedReasons || [];
      if (!stats.unresolvedRows.includes(rowNumber)) stats.unresolvedRows.push(rowNumber);
      stats.unresolvedReasons.push({
        rowNumber,
        reason: 'systemic-last-resort-halt',
        detail: typed.code,
        typed: {
          code: typed.code,
          subsystem: typed.subsystem,
          type: typed.type,
          stage: typed.stage,
          message: typed.message,
          hint: typed.hint,
        },
      });
      break;
    }
  }

  try {
    await base.syncPendingPhoneAssignments(source, pendingPhoneQueue, stats, runOptions);
  } catch (error) {
    stats.phoneSyncErrors++;
    stats.phoneSyncLastError = base.typedFailureSummary(error, { stage: error?.stage || 'fallback-phone-result-sync' });
  }

  const fallbackStats = fallback.snapshot();
  stats.modelCalls = fallbackStats.calls;
  return { ...stats, enabled: true, fallback: fallbackStats };
}

module.exports = { run, freshStats, companyContextFor, employerFallback, needsExistingRepair };
