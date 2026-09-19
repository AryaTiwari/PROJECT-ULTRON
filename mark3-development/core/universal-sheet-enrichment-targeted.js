'use strict';

// Exact-target wrapper around the universal deterministic sheet operator.
// Deterministic execution is always primary. Big Pickle is a bounded post-pass
// fallback only for unresolved employer/candidate ambiguity; it never owns sheet
// routing, schema inference, source selection or writes.

const sheets = require('./google-sheets-operator');
const targetResolver = require('./universal-sheet-target-resolver');
const base = require('./universal-sheet-enrichment-operator');
const fallbackPass = require('./universal-big-pickle-fallback-pass');
const fallback = require('./universal-big-pickle-fallback');
const aiBatchRescue = require('./universal-ai-batch-rescue');
const engine = require('./universal-enrichment-engine');
const typedErrors = require('./spreadsheet-enrichment-errors');
const diagnostics = require('./universal-enrichment-diagnostics');

function text(value) { return String(value == null ? '' : value).trim(); }

function syntheticResolution(request, sheetUrl) {
  const name = text(request.sheetName);
  const requestedGid = targetResolver.parseGid(sheetUrl);
  const sheetId = Number.isFinite(Number(request.sheetId))
    ? Number(request.sheetId)
    : (Number.isFinite(Number(requestedGid)) ? Number(requestedGid) : null);
  return {
    targeted: Boolean(name || sheetId != null),
    targetSource: 'explicit-target-metadata-fallback',
    requestedName: name || null,
    requestedGid,
    ignoredViewGid: false,
    target: name ? { name, sheetId } : null,
    metadataFallback: true,
  };
}

async function resolveExactRequest(request = {}) {
  const sheetUrl = request.sheetUrl || request.url;
  if (!sheetUrl) return { request, resolution: null };
  const spreadsheetId = sheets.spreadsheetId(sheetUrl);
  let resolution;
  try {
    const meta = await sheets.metadata(spreadsheetId);
    resolution = targetResolver.resolveTabs(meta, sheetUrl, {
      sheetName: request.sheetName || undefined,
      explicitNameAuthoritative: Boolean(request.explicitNameAuthoritative),
    });
  } catch (error) {
    if (!text(request.sheetName)) throw error;
    resolution = syntheticResolution(request, sheetUrl);
  }
  const target = resolution.target;
  return {
    request: {
      ...request,
      sheetUrl,
      sheetName: target?.name || request.sheetName || undefined,
      sheetId: target?.sheetId ?? request.sheetId ?? null,
    },
    resolution,
  };
}

function syntheticMetadata(spreadsheetId, request) {
  return {
    spreadsheetId,
    properties: { title: '' },
    sheets: [{
      properties: {
        title: request.sheetName,
        sheetId: request.sheetId == null ? 0 : Number(request.sheetId),
        index: 0,
        gridProperties: { rowCount: 1000, columnCount: 100 },
      },
    }],
    __ultronUniversalExactTargetFallback: true,
  };
}

async function withExactTargetGuards(request, fn) {
  if (!request?.sheetName) return fn();
  const originalMetadata = sheets.metadata;
  const originalLinks = sheets.linkedInHyperlinks;
  const spreadsheetId = sheets.spreadsheetId(request.sheetUrl || request.url);

  sheets.metadata = async function universalExactMetadata(id) {
    try {
      const meta = await originalMetadata(id);
      const list = Array.isArray(meta?.sheets) ? meta.sheets : [];
      const target = list.find((sheet) => text(sheet?.properties?.title).toLowerCase() === text(request.sheetName).toLowerCase())
        || (request.sheetId != null ? list.find((sheet) => Number(sheet?.properties?.sheetId) === Number(request.sheetId)) : null);
      if (target) return { ...meta, sheets: [target], __ultronUniversalExactTargetScoped: true };
      return syntheticMetadata(spreadsheetId, request);
    } catch {
      return syntheticMetadata(spreadsheetId, request);
    }
  };

  if (typeof originalLinks === 'function') {
    sheets.linkedInHyperlinks = async function universalBestEffortLinks(...args) {
      try { return await originalLinks(...args); } catch { return new Map(); }
    };
  }

  try {
    return await fn();
  } finally {
    sheets.metadata = originalMetadata;
    sheets.linkedInHyperlinks = originalLinks;
  }
}

async function mandatoryCompletionAudit(request, options = {}, terminalEvidence = {}) {
  const source = await base.readUniversalSheet(request.sheetUrl || request.url, {
    ...options,
    sheetName: request.sheetName || options.sheetName,
  });
  const analysis = engine.analyzeSheet(source.rows, {
    rowLimit: options.rowLimit,
    schema: options.schema,
  });

  const poc1IdentityIssues = [];
  const poc2OpenRows = [];
  const checkedRows = [];

  for (const record of analysis.rowPlans || []) {
    const rowNumber = Number(record.rowNumber);
    const plan = record.plan;
    if (!Number.isInteger(rowNumber)) continue;
    checkedRows.push(rowNumber);

    if (!plan?.anchor) {
      poc1IdentityIssues.push({ rowNumber, reason: 'missing-poc1-anchor' });
      continue;
    }

    if (plan.anchor.type !== 'company') {
      const anchorName = text(plan.anchor?.snapshot?.values?.name);
      const anchorLinkedin = text(plan.anchor?.snapshot?.values?.linkedin);
      if (!anchorName || !anchorLinkedin) {
        poc1IdentityIssues.push({
          rowNumber,
          reason: !anchorName ? 'missing-poc1-name' : 'missing-poc1-linkedin',
        });
      }
    }

    // Mandatory POC-2 identity is unresolved only when the ordinal-2 group is
    // genuinely empty. A known POC-2 with missing phone/email is a contact repair
    // target, not a missing-person target, and must never be sent back through
    // candidate discovery merely because a callback is still pending.
    const openPoc2 = (plan.groups?.open || [])
      .some((target) => !target.isAnchor && Number(target.group?.ordinal || 0) === 2);
    if (openPoc2) poc2OpenRows.push(rowNumber);
  }

  const unresolvedRows = [...new Set([
    ...poc1IdentityIssues.map((item) => item.rowNumber),
    ...poc2OpenRows,
  ])].sort((a, b) => a - b);

  const reasonMap = new Map();
  for (const item of terminalEvidence.reasons || []) {
    const rowNumber = Number(item?.rowNumber);
    if (!Number.isInteger(rowNumber)) continue;
    if (!reasonMap.has(rowNumber)) reasonMap.set(rowNumber, []);
    reasonMap.get(rowNumber).push({
      reason: text(item?.reason || item?.detail || 'unresolved'),
      detail: text(item?.detail || ''),
      typed: item?.typed || null,
    });
  }

  for (const issue of poc1IdentityIssues) {
    if (!reasonMap.has(issue.rowNumber)) reasonMap.set(issue.rowNumber, []);
    const existingReasons = reasonMap.get(issue.rowNumber).map((entry) => text(entry?.reason));
    if (!existingReasons.includes(issue.reason)) {
      reasonMap.get(issue.rowNumber).push({ reason: issue.reason, detail: '', typed: null });
    }
  }
  for (const rowNumber of poc2OpenRows) {
    if (!reasonMap.has(rowNumber)) {
      reasonMap.set(rowNumber, [{
        reason: 'no-safe-verified-poc2-after-all-strategies',
        detail: '',
        typed: null,
      }]);
    }
  }

  const issues = [];
  for (const rowNumber of unresolvedRows) {
    const reasons = reasonMap.get(rowNumber) || [{
      reason: 'no-safe-verified-poc2-after-all-strategies',
      detail: '',
      typed: null,
    }];
    const isPoc1 = poc1IdentityIssues.some((item) => Number(item.rowNumber) === rowNumber);
    for (const entry of reasons) {
      const target = isPoc1 ? 'POC-1' : 'POC-2';
      const groupOrdinal = isPoc1 ? 1 : 2;
      if (entry?.typed?.code) {
        issues.push(diagnostics.typedIssue(entry.typed, {
          category: 'provider',
          severity: 'BLOCKER',
          blocking: true,
          retryable: true,
          rowNumber,
          groupOrdinal,
          target,
        }));
        continue;
      }
      issues.push(diagnostics.issueFromReason(entry?.reason, {
        rowNumber,
        groupOrdinal,
        target,
        detail: entry?.detail || '',
      }));
    }
  }
  const uniqueIssues = diagnostics.uniqueIssues(issues);
  const terminalRows = [...new Set(uniqueIssues
    .filter((issue) => issue.blocking && issue.retryable === false)
    .map((issue) => Number(issue.rowNumber))
    .filter(Number.isInteger))].sort((a, b) => a - b);
  const retryableRows = [...new Set(uniqueIssues
    .filter((issue) => issue.blocking && issue.retryable === true)
    .map((issue) => Number(issue.rowNumber))
    .filter(Number.isInteger))].sort((a, b) => a - b);
  const complete = unresolvedRows.length === 0;
  const statusCode = complete
    ? 'RUN_COMPLETE'
    : (terminalRows.length ? 'MANDATORY_DATA_EXHAUSTED' : 'MANDATORY_RETRY_REQUIRED');

  return {
    checkedRows,
    mandatoryRowsChecked: checkedRows.length,
    poc1IdentityIssues,
    poc2OpenRows,
    unresolvedRows,
    terminalRows,
    retryableRows,
    complete,
    status: complete ? 'COMPLETE' : (terminalRows.length ? 'TERMINAL_EXHAUSTED' : 'RETRY_REQUIRED'),
    statusCode,
    reasons: Object.fromEntries([...reasonMap.entries()].map(([rowNumber, entries]) => [
      rowNumber,
      entries.map((entry) => ({
        reason: entry?.reason || 'unresolved',
        detail: entry?.detail || '',
        typedCode: entry?.typed?.code || null,
      })),
    ])),
    issues: uniqueIssues,
  };
}

function mergePrimaryAndFallback(primary, fb) {
  if (!fb?.attempted) return primary;
  const stats = { ...(primary.stats || {}) };
  for (const field of [
    'rowsChanged','cellsChanged','candidateSearches','candidateCacheHits','candidatesDiscovered',
    'hydrationAttempts','hydrationFailures','newPeopleSelected','identityConflicts',
    'existingVerificationAttempts','existingVerificationFailures','existingGroupsRepaired',
    'embeddedDesignationWrites','anchorFieldsFilled','orphanContactTargets','orphanContactVerified',
    'orphanContactBlocked'
  ]) {
    stats[field] = Number(stats[field] || 0) + Number(fb[field] || 0);
  }
  stats.unfilledOpenGroups = Number(fb.unresolvedTargets || 0);
  return { ...primary, stats };
}


function providerRetryReasonsFromPrimary(stats = {}) {
  const unresolvedRows = new Set(
    (stats.deferredPoc2Rows || []).map((value) => Number(value)).filter(Number.isInteger)
  );
  const reasons = [];
  for (const item of stats.discoveryDiagnostics || []) {
    const code = text(item?.code).toUpperCase();
    const hasRowNumber = item?.rowNumber !== null && item?.rowNumber !== undefined && item?.rowNumber !== '';
    const rowNumber = hasRowNumber ? Number(item.rowNumber) : NaN;
    if (!Number.isInteger(rowNumber) || !unresolvedRows.has(rowNumber)) continue;
    if (!/^LINKEDIN_(?:DAILY|HOURLY)_CAP$/.test(code)) continue;

    const error = new Error(text(item?.message || code));
    error.code = code;
    error.subsystem = 'LINKEDIN';
    error.errorType = 'RATE_LIMIT';
    error.stage = 'candidate-discovery';
    const typed = typedErrors.normalize(error, { stage: 'candidate-discovery' });

    reasons.push({
      rowNumber,
      reason: 'provider-retry-required',
      detail: code,
      typed: {
        code: typed.code,
        subsystem: typed.subsystem,
        type: typed.type,
        stage: typed.stage,
        message: typed.message,
        hint: typed.hint,
      },
    });
  }
  return reasons;
}

function mergePocPhaseResults(results = []) {
  const completed = (Array.isArray(results) ? results : []).filter(Boolean);
  if (!completed.length) return null;
  const last = completed[completed.length - 1];
  const stats = { ...(last.stats || {}) };

  const additive = [
    'rowsChanged','cellsChanged','anchorFieldsFilled','candidateSearches','candidateBroadSearches',
    'candidatePrioritySearches','candidatePrioritySearchFailures','candidateCacheHits','candidatesDiscovered',
    'linkedinFallbackSearches','linkedinFallbackCompanySearches','linkedinFallbackCompanyProfiles',
    'linkedinFallbackCompanyUrns','linkedinFallbackCurrentCompanySearches','linkedinFallbackEmployeeSearches',
    'linkedinFallbackProfileVerifications','linkedinFallbackFailures','linkedinFallbackProfilesFound',
    'linkedinFallbackVerifiedCandidates','publicIndexSearchCalls','publicIndexProfilesFound',
    'publicIndexApolloVerificationAttempts','publicIndexApolloVerifiedCandidates','publicIndexFailures',
    'linkedinHydrationRecoveryAttempts','linkedinHydrationRecoverySuccesses','linkedinHydrationRecoveryFailures',
    'postHydrationDuplicates','existingVerificationAttempts','existingVerificationFailures',
    'existingDiscoveryIdentityMatches','existingPublicIndexSearches','existingPublicIndexVerificationAttempts',
    'existingPublicIndexVerified','existingGroupsRepaired','embeddedDesignationWrites','newPeopleSelected',
    'hydrationAttempts','hydrationFailures','lowConfidenceCandidates','manualPoc2Attempts','manualPoc2Filled',
    'manualPoc3Attempts','manualPoc3Filled','optionalPoc3Deferred','orphanContactTargets','orphanContactVerified',
    'orphanContactBlocked','orphanContactMismatches','identityConflicts','phoneCellsFilled','phoneRowsChanged',
    'phoneNotFound','phoneWriteSkippedPopulated','phoneSyncPolls','phoneSyncErrors'
  ];
  for (const field of additive) {
    stats[field] = completed.reduce((sum, item) => sum + Number(item?.stats?.[field] || 0), 0);
  }

  const concatFields = [
    'discoveryDiagnostics','existingRepairAudit','selectionAudit','rowFailureAudit'
  ];
  for (const field of concatFields) {
    stats[field] = completed.flatMap((item) => Array.isArray(item?.stats?.[field]) ? item.stats[field] : []);
  }

  const uniqueNumberFields = [
    'deferredPoc2Rows','primarySweepDeferredRows','deterministicRecheckRows',
    'deterministicRecheckResolvedRows','deterministicRecheckRemainingRows',
    'deterministicRecheckRemainingMandatoryRows','deterministicRecheckRemainingRepairRows',
    'deterministicRecheckRemainingWarningRows','deterministicRecheckResolvedMandatoryRows'
  ];
  for (const field of uniqueNumberFields) {
    stats[field] = [...new Set(completed.flatMap((item) =>
      Array.isArray(item?.stats?.[field]) ? item.stats[field].map(Number).filter(Number.isInteger) : []
    ))].sort((a, b) => a - b);
  }

  const leftoverByKey = new Map();
  for (const item of completed.flatMap((phase) => phase?.stats?.leftoverQueue || [])) {
    const key = `${item?.rowNumber ?? ''}|${item?.groupOrdinal ?? ''}|${item?.code || item?.reason || ''}`;
    leftoverByKey.set(key, item);
  }
  stats.leftoverQueue = [...leftoverByKey.values()];

  stats.haltedEarly = completed.some((item) => item?.stats?.haltedEarly);
  const halted = completed.find((item) => item?.stats?.haltedEarly);
  if (halted) {
    stats.haltAtRow = halted.stats.haltAtRow;
    stats.haltError = halted.stats.haltError;
  }
  stats.partialCompletion = completed.some((item) => item?.partialCompletion);
  stats.contactPhaseOrdinal = null;
  stats.contactPhaseLabel = 'POC-1 -> POC-2 -> POC-3';
  stats.pocPhaseSummaries = completed.map((item) => ({
    ordinal: Number(item.contactPhaseOrdinal || item?.stats?.contactPhaseOrdinal || 0),
    label: item.contactPhaseLabel || item?.stats?.contactPhaseLabel || '',
    rowsSeen: Number(item?.stats?.rowsSeen || 0),
    rowsProcessed: Number(item?.stats?.rowsProcessed || 0),
    rowsChanged: Number(item?.stats?.rowsChanged || 0),
    cellsChanged: Number(item?.stats?.cellsChanged || 0),
    newPeopleSelected: Number(item?.stats?.newPeopleSelected || 0),
    existingGroupsRepaired: Number(item?.stats?.existingGroupsRepaired || 0),
    unfilledOpenGroups: Number(item?.stats?.unfilledOpenGroups || 0),
    haltedEarly: Boolean(item?.stats?.haltedEarly),
  }));

  const phase2 = completed.find((item) => Number(item.contactPhaseOrdinal || item?.stats?.contactPhaseOrdinal) === 2);
  if (phase2?.stats) {
    stats.deferredPoc2Rows = [...(phase2.stats.deferredPoc2Rows || [])];
    stats.deferredOpenGroups = Number(phase2.stats.deferredOpenGroups || 0);
    stats.unfilledOpenGroups = Number(phase2.stats.unfilledOpenGroups || 0)
      + Number(completed.find((item) => Number(item.contactPhaseOrdinal || item?.stats?.contactPhaseOrdinal) === 3)?.stats?.unfilledOpenGroups || 0);
  }

  return {
    ...last,
    deterministic: true,
    completedFully: !stats.haltedEarly,
    partialCompletion: Boolean(stats.haltedEarly || completed.some((item) => item?.partialCompletion)),
    contactPhaseOrdinal: null,
    contactPhaseLabel: stats.contactPhaseLabel,
    pocPhaseResults: completed,
    stats,
  };
}

async function runPocPhasePipeline(request, runOptions = {}) {
  if (runOptions.dryRun || runOptions.pocPhasePipeline === false || runOptions.contactPhaseOrdinal) {
    return base.run(request, runOptions);
  }

  const phases = [];
  const definitions = [
    { ordinal: 1, resultsFirstSweep: false, deferOpenGroupSelectionToAi: false },
    { ordinal: 2, resultsFirstSweep: runOptions.resultsFirstSweep !== false, deferOpenGroupSelectionToAi: runOptions.deferOpenGroupSelectionToAi },
    { ordinal: 3, resultsFirstSweep: false, deferOpenGroupSelectionToAi: false },
  ];

  for (const phase of definitions) {
    const result = await base.run(request, {
      ...runOptions,
      contactPhaseOrdinal: phase.ordinal,
      targetOrdinals: [phase.ordinal],
      resultsFirstSweep: phase.resultsFirstSweep,
      deferOpenGroupSelectionToAi: phase.deferOpenGroupSelectionToAi,
    });
    phases.push(result);
    if (result?.stats?.haltedEarly) break;
  }

  return mergePocPhaseResults(phases);
}

function mergePrimaryAndAiRescue(primary, rescue) {
  if (!rescue?.attempted) return primary;
  const stats = { ...(primary.stats || {}) };
  for (const field of [
    'rowsChanged','cellsChanged','newPeopleSelected','embeddedDesignationWrites',
    'hydrationAttempts','hydrationFailures'
  ]) {
    stats[field] = Number(stats[field] || 0) + Number(rescue[field] || 0);
  }
  stats.existingGroupsRepaired = Number(stats.existingGroupsRepaired || 0) + Number(rescue.existingRepairsAccepted || 0);
  if (Number.isFinite(Number(rescue.unresolvedSlots))) {
    stats.unfilledOpenGroups = Number(rescue.unresolvedSlots || 0);
  }
  return { ...primary, stats };
}

async function run(request = {}, options = {}) {
  const exact = await resolveExactRequest(request);
  const sharedDiscoveryCache = options.discoveryCache instanceof Map ? options.discoveryCache : new Map();
  const phasedExecution = options.pocPhasePipeline !== false && !options.contactPhaseOrdinal;
  const boundedAiEnabled = !phasedExecution
    && aiBatchRescue.enabled()
    && options.apolloApproved === true
    && !options.dryRun;
  const runOptions = {
    ...options,
    discoveryCache: sharedDiscoveryCache,
    deferOpenGroupSelectionToAi: boundedAiEnabled,
    // Finish a cheap pass across all rows first. The deterministic operator then
    // re-reads and deeply retries only its structured leftover queue.
    resultsFirstSweep: options.resultsFirstSweep !== false,
  };
  return withExactTargetGuards(exact.request, async () => {
    // From this point onward, a successful deterministic primary is authoritative.
    // Optional fallback/decorating failures must never invalidate verified writes
    // that base.run() already committed to the worksheet.
    const primary = await runPocPhasePipeline(exact.request, runOptions);
    const primaryStats = { ...(primary.stats || {}) };
    const providerRetryReasons = providerRetryReasonsFromPrimary(primaryStats);
    let result = primary;
    let fb = null;
    let postPrimaryError = null;

    let aiRescue = null;
    try {
      const primaryHalted = Boolean(primary?.stats?.haltedEarly || primary?.partialCompletion && primary?.completedFully === false);
      if (primaryHalted) {
        aiRescue = {
          enabled: aiBatchRescue.enabled(),
          attempted: false,
          skippedReason: 'primary-systemic-halt',
          modelCalls: 0,
        };
        fb = {
          enabled: fallback.enabled(),
          attempted: false,
          skippedReason: 'primary-systemic-halt',
          modelCalls: 0,
          fallback: fallback.snapshot(),
        };
      } else if (phasedExecution) {
        aiRescue = {
          enabled: aiBatchRescue.enabled(),
          attempted: false,
          skippedReason: 'poc-phase-deterministic-only',
          modelCalls: 0,
          modelAttempts: 0,
          rowsOfferedForSelection: 0,
          unresolvedRows: [...new Set(primaryStats.deferredPoc2Rows || [])],
          unresolvedReasons: [],
        };
        fb = {
          enabled: fallback.enabled(),
          attempted: false,
          skippedReason: 'poc-phase-deterministic-only',
          modelCalls: 0,
          unresolvedRows: [...new Set(primaryStats.deferredPoc2Rows || [])],
          unresolvedReasons: [],
          fallback: fallback.snapshot(),
        };
      } else if (providerRetryReasons.length) {
        aiRescue = {
          enabled: aiBatchRescue.enabled(),
          attempted: false,
          skippedReason: 'provider-retry-required',
          modelCalls: 0,
          modelAttempts: 0,
          rowsOfferedForSelection: 0,
          unresolvedRows: providerRetryReasons.map((item) => item.rowNumber),
          unresolvedReasons: providerRetryReasons,
        };
        fb = {
          enabled: fallback.enabled(),
          attempted: false,
          skippedReason: 'provider-retry-required',
          modelCalls: 0,
          unresolvedRows: providerRetryReasons.map((item) => item.rowNumber),
          unresolvedReasons: providerRetryReasons,
          fallback: fallback.snapshot(),
        };
      } else if (!runOptions.dryRun && runOptions.apolloApproved === true && aiBatchRescue.enabled()) {
        aiRescue = await aiBatchRescue.run(exact.request, primary, runOptions);
        result = mergePrimaryAndAiRescue(primary, aiRescue);

        // Completion beats "made progress". Any mandatory POC-2 residue continues
        // into the next safe strategy, even when direct AI solved sibling rows.
        const unresolvedRows = [...new Set(
          (aiRescue?.unresolvedRows || [])
            .map((value) => Number(value))
            .filter(Number.isInteger)
        )];
        const unresolvedPoc2 = unresolvedRows.length;
        const lastResortEnabled = !/^(0|false|no|off)$/i.test(String(process.env.ULTRON_M3_UNIVERSAL_LAST_RESORT_POC2 || '1'));

        if (unresolvedPoc2 > 0 && lastResortEnabled && fallback.enabled()) {
          try {
            fb = await fallbackPass.run(exact.request, result, {
              ...runOptions,
              targetOrdinals: [2],
              targetRows: unresolvedRows,
              maxFallbackAttemptsPerTarget: 1,
            });
            result = mergePrimaryAndFallback(result, fb);
          } catch (error) {
            const typed = typedErrors.normalize(error, { stage: error?.stage || 'last-resort-poc2-fallback' });
            fb = {
              enabled: true,
              attempted: true,
              haltedEarly: true,
              skippedReason: 'last-resort-fallback-error',
              modelCalls: 0,
              unresolvedRows,
              error: {
                code: typed.code,
                subsystem: typed.subsystem,
                type: typed.type,
                stage: typed.stage,
                message: typed.message,
                hint: typed.hint,
              },
              fallback: fallback.snapshot(),
            };
          }
        } else {
          fb = {
            enabled: fallback.enabled(),
            attempted: false,
            skippedReason: unresolvedPoc2 <= 0
              ? 'poc2-resolved-before-last-resort'
              : 'last-resort-disabled',
            modelCalls: 0,
            unresolvedRows,
            fallback: fallback.snapshot(),
          };
        }
      } else if (!runOptions.dryRun && runOptions.apolloApproved === true && fallback.enabled()) {
        try {
          fb = await fallbackPass.run(exact.request, primary, runOptions);
          result = mergePrimaryAndFallback(primary, fb);
        } catch (error) {
          const typed = typedErrors.normalize(error, { stage: error?.stage || 'big-pickle-fallback-pass' });
          fb = {
            enabled: true,
            attempted: true,
            haltedEarly: true,
            skippedReason: 'fallback-error',
            modelCalls: 0,
            error: {
              code: typed.code,
              subsystem: typed.subsystem,
              type: typed.type,
              stage: typed.stage,
              message: typed.message,
              hint: typed.hint,
              attemptedRange: typed.attemptedRange || null,
              retryAttempts: typed.retryAttempts,
            },
            fallback: fallback.snapshot(),
          };
          result = primary;
        }
      }
    } catch (error) {
      if (!error?.code) error.code = 'UNIVERSAL_POST_PRIMARY_FAILURE';
      if (!error?.subsystem) error.subsystem = 'UNIVERSAL';
      if (!error?.errorType) error.errorType = 'INTERNAL';
      if (!error?.stage) error.stage = 'post-primary-orchestration';
      const typed = typedErrors.normalize(error, { stage: 'post-primary-orchestration' });
      postPrimaryError = {
        code: typed.code,
        subsystem: typed.subsystem,
        type: typed.type,
        stage: typed.stage,
        message: typed.message,
        hint: typed.hint,
        attemptedRange: typed.attemptedRange || null,
        retryAttempts: typed.retryAttempts,
      };
      // Preserve the deterministic primary result. A local orchestration/reporting
      // bug after verified writes is a warning, not a reason to report the whole
      // enrichment run as failed.
      result = primary;
      fb = fb || {
        enabled: fallback.enabled(),
        attempted: false,
        skippedReason: 'post-primary-error',
        modelCalls: 0,
        error: postPrimaryError,
        fallback: (() => { try { return fallback.snapshot(); } catch { return { enabled: fallback.enabled(), calls: 0, actualModels: [], personalApiFallbacks: 0 }; } })(),
      };
    }

    let completionGate = null;
    try {
      const terminalReasons = [
        ...providerRetryReasons,
        ...(aiRescue?.unresolvedReasons || []),
        ...(fb?.unresolvedReasons || []),
      ];
      completionGate = await mandatoryCompletionAudit(exact.request, runOptions, {
        reasons: terminalReasons,
      });
    } catch (error) {
      completionGate = {
        status: 'AUDIT_FAILED',
        statusCode: 'FINAL_AUDIT_FAILED',
        complete: false,
        unresolvedRows: [],
        terminalRows: [],
        retryableRows: [],
        issues: [{
          code: 'FINAL_AUDIT_FAILED',
          category: 'system',
          severity: 'BLOCKER',
          blocking: true,
          retryable: true,
          rowNumber: null,
          target: 'FINAL-AUDIT',
          message: 'The final live-sheet mandatory completion audit failed.',
          detail: text(error?.message || error),
          nextAction: 'Fix the audit/read failure and rerun the final audit before trusting completion status.',
        }],
        error: text(error?.message || error),
      };
    }

    const modelCalls = Number(aiRescue?.modelCalls || 0) + Number(fb?.modelCalls || fb?.fallback?.calls || 0);
    const decorated = {
      ...result,
      primaryStats,
      deterministicPrimary: true,
      deterministic: modelCalls === 0,
      fallbackModelUsed: modelCalls > 0,
      boundedAiBatchRescue: Boolean(aiRescue?.attempted),
      modelCalls,
      aiBatchRescue: aiRescue,
      bigPickleFallback: fb,
      completionGate,
      diagnostics: diagnostics.uniqueIssues([
        ...(completionGate?.issues || []),
        ...diagnostics.classifyLeftovers(primaryStats?.leftoverQueue || []).issues,
        ...diagnostics.runtimeIssues(primaryStats || {}),
        ...(Number(aiRescue?.rowsOfferedForSelection || 0) === 0 && Number(aiRescue?.modelAttempts || 0) === 0 && aiRescue?.attempted
          ? [diagnostics.issueFromReason('ai-skipped-no-verified-candidate-pool')]
          : []),
      ]),
      postPrimaryError,
      completedFully: !postPrimaryError && completionGate?.complete === true,
      partialCompletion: Boolean(postPrimaryError || completionGate?.complete !== true || result?.partialCompletion),
      resumeSafe: result?.resumeSafe !== false,
    };
    if (!exact.resolution) return decorated;
    return {
      ...decorated,
      requestedTarget: {
        targeted: exact.resolution.targeted,
        source: exact.resolution.targetSource,
        requestedName: exact.resolution.requestedName || null,
        requestedGid: exact.resolution.requestedGid,
        ignoredViewGid: exact.resolution.ignoredViewGid,
        sheetName: exact.resolution.target?.name || result.sheetName || null,
        sheetId: exact.resolution.target?.sheetId ?? exact.request.sheetId ?? null,
        metadataFallback: Boolean(exact.resolution.metadataFallback),
      },
    };
  });
}

function collapseDiagnosticBlockers(issues = []) {
  const blockers = diagnostics.uniqueIssues(issues || [])
    .filter((item) => item.blocking || item.severity === 'BLOCKER');
  const genericLifecycleCodes = new Set([
    'APOLLO_DISCOVERY_FAILED_FOR_POC2',
    'POC2_LAST_RESORT_RETRYABLE_FAILURE',
    'POC2_NO_DISCOVERY_CANDIDATES',
    'POC2_CANDIDATES_FAILED_VERIFICATION',
    'ROW_LOCAL_RECOVERABLE_FAILURE',
  ]);
  const byScope = new Map();
  for (const item of blockers) {
    const scope = `${item.rowNumber ?? ''}|${item.target || item.groupOrdinal || ''}`;
    if (!byScope.has(scope)) byScope.set(scope, []);
    byScope.get(scope).push(item);
  }

  const out = [];
  for (const scoped of byScope.values()) {
    const specific = scoped.filter((item) => !genericLifecycleCodes.has(text(item.code).toUpperCase()));
    const chosen = specific.length ? specific : scoped;
    const seen = new Set();
    for (const item of chosen) {
      const key = `${item.rowNumber ?? ''}|${item.target || item.groupOrdinal || ''}|${text(item.code).toUpperCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

function formatDiagnosticFooter(result) {
  const gate = result?.completionGate || {};
  const allIssues = diagnostics.uniqueIssues(result?.diagnostics || gate?.issues || []);
  const gateBlockers = collapseDiagnosticBlockers(gate?.issues || []);
  const blockers = gateBlockers.length
    ? gateBlockers
    : collapseDiagnosticBlockers(allIssues);
  const pending = allIssues.filter((item) => item.severity === 'PENDING' || item.category === 'repair');
  const warnings = allIssues.filter((item) => item.severity === 'WARNING' && item.category !== 'repair');
  const infos = allIssues.filter((item) => item.severity === 'INFO');

  const formatList = (items, fallback = 'none') =>
    items.length ? items.slice(0, 8).map(diagnostics.formatIssue).join(' | ') : fallback;

  const statusCode = gate.statusCode || gate.status || (blockers.length ? 'RUN_WITH_BLOCKERS' : 'RUN_COMPLETE');
  const rootCause = blockers.length === 1
    ? blockers[0].code
    : (blockers.length > 1 ? 'MULTIPLE_BLOCKERS' : 'NONE');

  return [
    '',
    'ULTRON_DIAGNOSTICS',
    `RUN_STATUS: ${statusCode}`,
    `ROOT_CAUSE: ${rootCause}`,
    `MANDATORY_BLOCKERS: ${formatList(blockers)}`,
    `REPAIR_OR_PENDING: ${formatList(pending)}`,
    `WARNINGS: ${formatList(warnings)}`,
    `INFO: ${formatList(infos)}`,
  ].join('\n');
}

function formatResult(result) {
  const primaryView = result?.primaryStats ? { ...result, stats: result.primaryStats } : result;
  const basePrimary = base.formatResult(primaryView).replace(/\s*AI\/model calls:\s*0\.\s*$/i, '').trim();
  const phaseSummaries = Array.isArray(result?.stats?.pocPhaseSummaries)
    ? result.stats.pocPhaseSummaries
    : Array.isArray(result?.primaryStats?.pocPhaseSummaries)
      ? result.primaryStats.pocPhaseSummaries
      : [];
  const phaseText = phaseSummaries.length
    ? ` POC-phase pipeline: ${phaseSummaries.map((phase) =>
        `${phase.label || `POC-${phase.ordinal}`}: ${phase.cellsChanged || 0} cells / ${phase.rowsChanged || 0} rows changed, ${phase.newPeopleSelected || 0} new people, ${phase.existingGroupsRepaired || 0} repairs, ${phase.unfilledOpenGroups || 0} unfilled${phase.haltedEarly ? ' [HALTED]' : ''}`
      ).join(' | ')}.`
    : '';
  const primary = `${basePrimary}${phaseText}`;
  const ai = result?.aiBatchRescue;
  const fb = result?.bigPickleFallback;
  const diagnosticFooter = formatDiagnosticFooter(result);
  if (ai?.attempted) {
    const audit = (ai.selectionAudit || []).slice(0, 6).map((item) =>
      `row ${item.rowNumber} POC-${item.slot || '?'} ${item.mode || 'fill'} ${item.name || item.candidateKey} (${item.fields?.join('/') || 'verified'})`
    );
    const errors = (ai.errors || []).slice(0, 3).map((item) => `${item.purpose || 'ai'}:${item.code || 'ERROR'} ${item.message || ''}`);
    const gate = result?.completionGate || {};
    const gateIssues = collapseDiagnosticBlockers(gate.issues || []);
    const gateText = ` Completion gate: ${gate.statusCode || gate.status || 'UNKNOWN'}; mandatory rows checked ${gate.mandatoryRowsChecked || 0}; unresolved mandatory rows [${(gate.unresolvedRows || []).join(', ') || 'none'}]; terminal rows [${(gate.terminalRows || []).join(', ') || 'none'}]; retryable rows [${(gate.retryableRows || []).join(', ') || 'none'}]. Problems: ${gateIssues.map(diagnostics.formatIssue).join(' | ') || '[INFO] NO_MANDATORY_BLOCKERS'}.`;
    const noCandidatePool = Number(ai.rowsOfferedForSelection || 0) === 0 && Number(ai.modelAttempts || 0) === 0;
    const aiSkipExplanation = noCandidatePool
      ? ` ${diagnostics.formatIssue(diagnostics.issueFromReason('ai-skipped-no-verified-candidate-pool'))}`
      : '';
    return `${primary} Bounded AI batch rescue: ${ai.modelCalls || 0} successful model responses from ${ai.modelAttempts || 0}/${ai.maxCalls || 3} whole-run logical attempts (${ai.contextCalls || 0} context, ${ai.selectionCalls || 0} selection, ${ai.reviewerCalls || 0} reviewer); ${ai.modelFailures || 0} model/routing failures; ${ai.rowsOfferedForSelection || 0} rows and ${ai.slotsOfferedForSelection || 0} POC targets offered; ${ai.aiSelectionsProposed || 0} selections proposed, ${ai.aiSelectionsAccepted || 0} Apollo-verified selections accepted (${ai.newPeopleSelected || 0} new POCs, ${ai.existingRepairsAccepted || 0} existing POC repairs), ${ai.aiSelectionRejects || 0} rejected by deterministic identity/employer/write safety; ${ai.employersResolvedByAi || 0} employers recovered from supplied row evidence; ${ai.candidatesDiscovered || 0} verified candidates discovered; Apollo discovery calls ${ai.candidateSearches || 0}; LinkedIn sparse-company fallback ${ai.linkedinFallbackCompanySearches || 0} company searches/${ai.linkedinFallbackCompanyProfiles || 0} company profiles/${ai.linkedinFallbackCompanyUrns || 0} company URNs/${ai.linkedinFallbackCurrentCompanySearches || 0} current-company people searches/${ai.linkedinFallbackEmployeeSearches || 0} employee-page searches/${ai.linkedinFallbackSearches || 0} generic people searches/${ai.linkedinFallbackProfilesFound || 0} profile refs/${ai.linkedinFallbackProfileVerifications || 0} current-employer profile verifications/${ai.linkedinFallbackVerifiedCandidates || 0} Apollo identities accepted; public-index fallback ${ai.publicIndexSearchCalls || 0} searches/${ai.publicIndexProfilesFound || 0} LinkedIn profile refs/${ai.publicIndexApolloVerificationAttempts || 0} Apollo verification attempts/${ai.publicIndexApolloVerifiedCandidates || 0} exact verified candidates/${ai.publicIndexFailures || 0} failures; ${ai.hydrationAttempts || 0} final hydration attempts/${ai.hydrationFailures || 0} failures; ${ai.hydrationFallbackAttempts || 0} bounded post-selection fallback hydration attempts/${ai.hydrationFallbackAccepted || 0} accepted; rescue changed ${ai.cellsChanged || 0} cells across ${ai.rowsChanged || 0} rows; ${ai.phoneCellsFilled || 0} phone cells completed, ${ai.phoneStillPending || 0} phones still pending; ${ai.unresolvedSlots || 0} slots unresolved. Models [${(ai.actualModels || []).join(', ') || 'none'}]. Credential source: env-only direct API. Direct providers [${(ai.directProvidersUsed || []).join(', ') || 'none'}]; OmniRoute calls 0; direct attempt audit ${(ai.directAttemptAudit || []).length}.${aiSkipExplanation} Last-resort POC-2 fallback: ${fb?.attempted ? 'attempted for every exact unresolved POC-2 row' : 'not needed'}; POC-3 was excluded from expensive fallback.${gateText}${errors.length ? ` AI diagnostics: ${errors.join(' | ')}.` : ''}${audit.length ? ` Samples: ${audit.join('; ')}.` : ''}${diagnosticFooter}`;
  }
  if (!fb?.enabled) return `${primary} Primary execution remained fully deterministic; Big Pickle fallback was disabled. AI/model calls: 0.${diagnosticFooter}`;
  const model = fb.fallback || {};
  if (fb.skippedReason === 'primary-systemic-halt') {
    return `${primary} Big Pickle fallback was not attempted because the deterministic primary halted safely on a systemic typed error. Earlier verified writes were preserved. AI/model calls: 0.${diagnosticFooter}`;
  }
  if (fb.skippedReason === 'fallback-error') {
    const e = fb.error || {};
    return `${primary} Primary deterministic work was preserved. Big Pickle fallback stopped independently with [${e.subsystem || 'BIG_PICKLE'}/${e.type || 'INTERNAL'}] ${e.code || 'BIG_PICKLE_FALLBACK_FAILED'} @ ${e.stage || 'big-pickle-fallback-pass'}: ${e.message || 'unknown fallback failure'}. ${e.hint || ''} Personal API fallbacks 0.${diagnosticFooter}`;
  }
  if (fb.skippedReason === 'provider-retry-required') {
    return `${primary} Primary engine: deterministic. AI selection and last-resort fallback were intentionally skipped because a required provider safety window is exhausted; retry only the affected mandatory row after the provider window resets. AI/model calls: 0.${diagnosticFooter}`;
  }
  if (!fb.attempted) {
    return `${primary} Primary engine: deterministic. Big Pickle fallback was available but not needed because the deterministic pass left no eligible ambiguity to resolve. AI/model calls: 0.${diagnosticFooter}`;
  }
  const combinedCells = Number(result?.primaryStats?.cellsChanged || 0) + Number(fb.cellsChanged || 0);
  const fallbackHalt = fb.haltedEarly && fb.haltError
    ? ` Fallback halted safely at row ${fb.haltAtRow || '?'} with [${fb.haltError.subsystem || 'BIG_PICKLE'}/${fb.haltError.type || 'INTERNAL'}] ${fb.haltError.code || 'BIG_PICKLE_FALLBACK_FAILED'} @ ${fb.haltError.stage || 'fallback-row-enrichment'}: ${fb.haltError.message || 'unknown fallback failure'}. Deterministic primary writes remain valid.`
    : '';
  const fallbackRows = fb.rowFailures
    ? (() => {
        const samples = (fb.rowFailureAudit || []).slice(0, 4).map((item) =>
          `row ${item.rowNumber || '?'} [${item.subsystem || 'UNIVERSAL'}/${item.type || 'INTERNAL'}] ${item.code || 'UNKNOWN'} @ ${item.stage || 'fallback-row-enrichment'}`
        );
        return ` Row fault containment captured ${fb.rowFailures} fallback row failure${Number(fb.rowFailures) === 1 ? '' : 's'}; ${fb.recoverableRowFailures || 0} continued safely.${samples.length ? ` Samples: ${samples.join('; ')}.` : ''}`;
      })()
    : '';
  const fallbackText = `Big Pickle fallback: ${fb.modelCalls || 0} model call${Number(fb.modelCalls || 0) === 1 ? '' : 's'}; ${fb.candidateFallbackSelections || 0} ambiguous candidate selection${Number(fb.candidateFallbackSelections || 0) === 1 ? '' : 's'} recovered; ${fb.employerFallbackSuccesses || 0}/${fb.employerFallbackAttempts || 0} employer ambiguities resolved; ${fb.existingGroupsRepaired || 0} existing group${Number(fb.existingGroupsRepaired || 0) === 1 ? '' : 's'} repaired after fallback employer verification; ${fb.embeddedDesignationWrites || 0} designation upgrade${Number(fb.embeddedDesignationWrites || 0) === 1 ? '' : 's'}; fallback changed ${fb.cellsChanged || 0} cells across ${fb.rowsChanged || 0} rows; combined cells changed ${combinedCells}; ${fb.candidateFallbackAbstains || 0} abstain${Number(fb.candidateFallbackAbstains || 0) === 1 ? '' : 's'}; models [${(model.actualModels || []).join(', ') || 'none'}]; personal API fallbacks 0.${fallbackRows}${fallbackHalt}`;
  return `${primary} Primary engine: deterministic. ${fallbackText}${diagnosticFooter}`;
}

module.exports = {
  ...base,
  run,
  formatResult,
  diagnostics,
  formatDiagnosticFooter,
  collapseDiagnosticBlockers,
  resolveExactRequest,
  syntheticResolution,
  withExactTargetGuards,
  mandatoryCompletionAudit,
  mergePrimaryAndFallback,
  providerRetryReasonsFromPrimary,
  mergePocPhaseResults,
  runPocPhasePipeline,
  mergePrimaryAndAiRescue,
};
