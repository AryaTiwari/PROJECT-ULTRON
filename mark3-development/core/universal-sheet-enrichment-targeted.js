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
    // An explicit tab name is enough to read an exact A1 range safely. Metadata is
    // not allowed to become a single point of failure for a user-named worksheet.
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

async function run(request = {}, options = {}) {
  const exact = await resolveExactRequest(request);
  return withExactTargetGuards(exact.request, async () => {
    const primary = await base.run(exact.request, options);
    let result = primary;
    let fb = null;

    if (!options.dryRun && options.apolloApproved === true && fallback.enabled()) {
      fb = await fallbackPass.run(exact.request, primary, options);
      result = mergePrimaryAndFallback(primary, fb);
    }

    const modelCalls = Number(fb?.modelCalls || 0);
    const decorated = {
      ...result,
      deterministicPrimary: true,
      deterministic: modelCalls === 0,
      fallbackModelUsed: modelCalls > 0,
      modelCalls,
      bigPickleFallback: fb,
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
  const primary = base.formatResult(result).replace(/\s*AI\/model calls:\s*0\.\s*$/i, '').trim();
  const fb = result?.bigPickleFallback;
  if (!fb?.enabled) return `${primary} Primary execution remained fully deterministic; Big Pickle fallback was disabled. AI/model calls: 0.`;
  const model = fb.fallback || {};
  const fallbackText = fb.attempted
    ? `Big Pickle fallback: ${fb.modelCalls || 0} model call${Number(fb.modelCalls || 0) === 1 ? '' : 's'}; ${fb.candidateFallbackSelections || 0} ambiguous candidate selection${Number(fb.candidateFallbackSelections || 0) === 1 ? '' : 's'} recovered; ${fb.employerFallbackSuccesses || 0}/${fb.employerFallbackAttempts || 0} employer ambiguities resolved; ${fb.existingGroupsRepaired || 0} existing group${Number(fb.existingGroupsRepaired || 0) === 1 ? '' : 's'} repaired after fallback employer verification; ${fb.embeddedDesignationWrites || 0} designation upgrade${Number(fb.embeddedDesignationWrites || 0) === 1 ? '' : 's'}; ${fb.cellsChanged || 0} additional cell${Number(fb.cellsChanged || 0) === 1 ? '' : 's'} written; ${fb.candidateFallbackAbstains || 0} abstain${Number(fb.candidateFallbackAbstains || 0) === 1 ? '' : 's'}; models [${(model.actualModels || []).join(', ') || 'none'}]; personal API fallbacks 0.`
    : 'Big Pickle fallback was available but not needed because the deterministic pass left no eligible ambiguity to resolve. AI/model calls: 0.';
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
};
