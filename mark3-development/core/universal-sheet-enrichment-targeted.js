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
const typedErrors = require('./spreadsheet-enrichment-errors');

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
  const boundedAiEnabled = aiBatchRescue.enabled() && options.apolloApproved === true && !options.dryRun;
  const runOptions = {
    ...options,
    discoveryCache: sharedDiscoveryCache,
    deferOpenGroupSelectionToAi: boundedAiEnabled,
  };
  return withExactTargetGuards(exact.request, async () => {
    // From this point onward, a successful deterministic primary is authoritative.
    // Optional fallback/decorating failures must never invalidate verified writes
    // that base.run() already committed to the worksheet.
    const primary = await base.run(exact.request, runOptions);
    const primaryStats = { ...(primary.stats || {}) };
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
      } else if (!runOptions.dryRun && runOptions.apolloApproved === true && aiBatchRescue.enabled()) {
        aiRescue = await aiBatchRescue.run(exact.request, primary, runOptions);
        result = mergePrimaryAndAiRescue(primary, aiRescue);

        // Manual/deterministic POC-2 is primary, direct env AI is secondary.
        // If POC-2 is still unresolved, permit one tightly bounded last-resort
        // fallback attempt per remaining POC-2 target. POC-3 is never sent here.
        const unresolvedPoc2 = Number(aiRescue?.unresolvedSlots ?? primary?.stats?.deferredOpenGroups ?? 0);
        const lastResortEnabled = !/^(0|false|no|off)$/i.test(String(process.env.ULTRON_M3_UNIVERSAL_LAST_RESORT_POC2 || '1'));
        if (unresolvedPoc2 > 0 && lastResortEnabled && fallback.enabled()) {
          try {
            fb = await fallbackPass.run(exact.request, result, {
              ...runOptions,
              targetOrdinals: [2],
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
            skippedReason: unresolvedPoc2 > 0 ? 'last-resort-disabled' : 'poc2-resolved-before-last-resort',
            modelCalls: 0,
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
      postPrimaryError,
      completedFully: postPrimaryError ? false : result?.completedFully,
      partialCompletion: Boolean(postPrimaryError || result?.partialCompletion),
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

function formatResult(result) {
  const primaryView = result?.primaryStats ? { ...result, stats: result.primaryStats } : result;
  const primary = base.formatResult(primaryView).replace(/\s*AI\/model calls:\s*0\.\s*$/i, '').trim();
  const ai = result?.aiBatchRescue;
  const fb = result?.bigPickleFallback;
  if (ai?.attempted) {
    const audit = (ai.selectionAudit || []).slice(0, 6).map((item) =>
      `row ${item.rowNumber} POC-${item.slot || '?'} ${item.mode || 'fill'} ${item.name || item.candidateKey} (${item.fields?.join('/') || 'verified'})`
    );
    const errors = (ai.errors || []).slice(0, 3).map((item) => `${item.purpose || 'ai'}:${item.code || 'ERROR'} ${item.message || ''}`);
    return `${primary} Bounded AI batch rescue: ${ai.modelCalls || 0} successful model responses from ${ai.modelAttempts || 0}/${ai.maxCalls || 3} whole-run logical attempts (${ai.contextCalls || 0} context, ${ai.selectionCalls || 0} selection, ${ai.reviewerCalls || 0} reviewer); ${ai.modelFailures || 0} model/routing failures; ${ai.rowsOfferedForSelection || 0} rows and ${ai.slotsOfferedForSelection || 0} POC targets offered; ${ai.aiSelectionsProposed || 0} selections proposed, ${ai.aiSelectionsAccepted || 0} Apollo-verified selections accepted (${ai.newPeopleSelected || 0} new POCs, ${ai.existingRepairsAccepted || 0} existing POC repairs), ${ai.aiSelectionRejects || 0} rejected by deterministic identity/employer/write safety; ${ai.employersResolvedByAi || 0} employers recovered from supplied row evidence; ${ai.candidatesDiscovered || 0} Apollo candidates discovered; ${ai.hydrationAttempts || 0} final hydration attempts/${ai.hydrationFailures || 0} failures; rescue changed ${ai.cellsChanged || 0} cells across ${ai.rowsChanged || 0} rows; ${ai.phoneCellsFilled || 0} phone cells completed, ${ai.phoneStillPending || 0} phones still pending; ${ai.unresolvedSlots || 0} slots unresolved. Models [${(ai.actualModels || []).join(', ') || 'none'}]. Credential source: env-only direct API. Direct providers [${(ai.directProvidersUsed || []).join(', ') || 'none'}]; OmniRoute calls 0; direct attempt audit ${(ai.directAttemptAudit || []).length}. Last-resort POC-2 fallback: \${fb?.attempted ? 'attempted after manual + direct AI residue' : 'not needed'}; POC-3 was excluded from expensive fallback.${errors.length ? ` AI diagnostics: ${errors.join(' | ')}.` : ''}${audit.length ? ` Samples: ${audit.join('; ')}.` : ''}`;
  }
  if (!fb?.enabled) return `${primary} Primary execution remained fully deterministic; Big Pickle fallback was disabled. AI/model calls: 0.`;
  const model = fb.fallback || {};
  if (fb.skippedReason === 'primary-systemic-halt') {
    return `${primary} Big Pickle fallback was not attempted because the deterministic primary halted safely on a systemic typed error. Earlier verified writes were preserved. AI/model calls: 0.`;
  }
  if (fb.skippedReason === 'fallback-error') {
    const e = fb.error || {};
    return `${primary} Primary deterministic work was preserved. Big Pickle fallback stopped independently with [${e.subsystem || 'BIG_PICKLE'}/${e.type || 'INTERNAL'}] ${e.code || 'BIG_PICKLE_FALLBACK_FAILED'} @ ${e.stage || 'big-pickle-fallback-pass'}: ${e.message || 'unknown fallback failure'}. ${e.hint || ''} Personal API fallbacks 0.`;
  }
  if (!fb.attempted) {
    return `${primary} Primary engine: deterministic. Big Pickle fallback was available but not needed because the deterministic pass left no eligible ambiguity to resolve. AI/model calls: 0.`;
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
  return `${primary} Primary engine: deterministic. ${fallbackText}`;
}

module.exports = {
  ...base,
  run,
  formatResult,
  resolveExactRequest,
  syntheticResolution,
  withExactTargetGuards,
  mergePrimaryAndFallback,
  mergePrimaryAndAiRescue,
};
