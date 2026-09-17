'use strict';

// Defense-in-depth wrapper around the universal deterministic sheet operator.
// Any explicit Google Sheets gid or requested sheetName is resolved to one exact
// worksheet before execution. Schema-confidence scanning across tabs is allowed
// only when neither target is supplied.

const sheets = require('./google-sheets-operator');
const targetResolver = require('./universal-sheet-target-resolver');
const base = require('./universal-sheet-enrichment-operator');

async function resolveExactRequest(request = {}) {
  const sheetUrl = request.sheetUrl || request.url;
  if (!sheetUrl) return { request, resolution: null };
  const spreadsheetId = sheets.spreadsheetId(sheetUrl);
  const meta = await sheets.metadata(spreadsheetId);
  const resolution = targetResolver.resolveTabs(meta, sheetUrl, {
    sheetName: request.sheetName || undefined,
  });
  const target = resolution.target;
  return {
    request: {
      ...request,
      sheetUrl,
      sheetName: target?.name || request.sheetName || undefined,
    },
    resolution,
  };
}

async function run(request = {}, options = {}) {
  const exact = await resolveExactRequest(request);
  const result = await base.run(exact.request, options);
  if (!exact.resolution) return result;
  return {
    ...result,
    requestedTarget: {
      targeted: exact.resolution.targeted,
      source: exact.resolution.targetSource,
      requestedName: exact.resolution.requestedName || null,
      requestedGid: exact.resolution.requestedGid,
      sheetName: exact.resolution.target?.name || result.sheetName || null,
      sheetId: exact.resolution.target?.sheetId ?? null,
    },
  };
}

module.exports = {
  ...base,
  run,
  resolveExactRequest,
};
