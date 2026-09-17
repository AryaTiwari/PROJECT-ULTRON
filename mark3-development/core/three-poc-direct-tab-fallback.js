'use strict';

// Temporary exact-tab scope for legacy Google 3-POC execution. When enabled,
// metadata is always reduced to the configured tab and sheetGid() is forced to
// the configured gid, so stale view state in a workbook mention cannot change scope.
// Rich LinkedIn hyperlink probing is best-effort. Inspection itself uses a direct
// exact-tab values preflight, so a valid anchored layout cannot be hidden by
// legacy workbook scanning or optional metadata plumbing.

const threePoc = require('./three-poc-enrichment-operator');
const googleSheets = require('./google-sheets-operator');

const INSTALL_FLAG = Symbol.for('ultron.mark3.threePocDirectTabFallback.installed');
const stats = {
  metadataAttempts: 0,
  metadataFallbacks: 0,
  metadataScoped: 0,
  targetMisses: 0,
  gidOverrides: 0,
  richLinkAttempts: 0,
  richLinkFallbacks: 0,
  valuesReads: 0,
  directInspectionAttempts: 0,
  directInspectionSuccesses: 0,
  directInspectionFailures: 0,
  enrichmentPreflightAttempts: 0,
  enrichmentPreflightSuccesses: 0,
  enrichmentPreflightFailures: 0,
  lastValuesRange: null,
  lastValuesRowCount: 0,
  lastHeaderPreview: [],
  lastError: null,
  lastRichLinkError: null,
  lastValuesError: null,
  lastDirectInspection: null,
  targetSheet: null,
  targetGid: null,
};

function enabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.ULTRON_M3_THREE_POC_BIG_PICKLE || ''));
}

function targetSheet() {
  return String(process.env.ULTRON_M3_THREE_POC_TARGET_SHEET || '').trim();
}

function targetGid(source) {
  const explicit = Number(process.env.ULTRON_M3_THREE_POC_TARGET_GID || 0);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const fromUrl = googleSheets.sheetGid(source);
  return Number.isFinite(fromUrl) && fromUrl >= 0 ? fromUrl : null;
}

function syntheticMetadata(id, name, gid) {
  return {
    spreadsheetId: id,
    properties: { title: '' },
    sheets: [{
      properties: {
        title: name,
        sheetId: gid == null ? 0 : Number(gid),
        index: 0,
        gridProperties: { rowCount: 1000, columnCount: 100 },
      },
    }],
    __ultronExactTabMetadataFallback: true,
  };
}

function restrictMetadata(meta, name, gid) {
  const sheets = Array.isArray(meta?.sheets) ? meta.sheets : [];
  const byName = sheets.find((sheet) => String(sheet?.properties?.title || '').trim().toLowerCase() === name.toLowerCase());
  const byGid = gid == null ? null : sheets.find((sheet) => Number(sheet?.properties?.sheetId) === Number(gid));
  const chosen = byName || byGid || null;
  if (!chosen) return null;
  return {
    ...meta,
    sheets: [chosen],
    __ultronExactTabScoped: true,
  };
}

function compactRow(row) {
  return (Array.isArray(row) ? row : []).slice(0, 20).map((value) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 120));
}

function layoutSummary(layout) {
  return {
    schema: layout.schema,
    headerRowNumber: layout.headerRowNumber,
    linkedinIndex: layout.linkedinIndex,
    first: {
      nameIndex: layout.first?.nameIndex ?? -1,
      phoneIndex: layout.first?.phoneIndex ?? -1,
      emailIndex: layout.first?.emailIndex ?? -1,
    },
    second: {
      nameIndex: layout.second?.nameIndex ?? -1,
      phoneIndex: layout.second?.phoneIndex ?? -1,
      emailIndex: layout.second?.emailIndex ?? -1,
    },
    third: {
      nameIndex: layout.third?.nameIndex ?? -1,
      phoneIndex: layout.third?.phoneIndex ?? -1,
      emailIndex: layout.third?.emailIndex ?? -1,
    },
  };
}

async function directExactTabRead(source, mode = 'inspection') {
  const spreadsheetId = googleSheets.spreadsheetId(source);
  const name = targetSheet();
  const gid = targetGid(source);
  const range = `${googleSheets.quoteSheet(name)}!A:ZZ`;
  const inspection = mode === 'inspection';
  if (inspection) stats.directInspectionAttempts++;
  else stats.enrichmentPreflightAttempts++;

  let rows = [];
  try {
    rows = await googleSheets.values(spreadsheetId, range);
    const layout = threePoc.detectThreePocLayout(rows);
    const diagnostic = {
      ok: true,
      mode,
      spreadsheetId,
      sheetName: name,
      sheetId: gid,
      range,
      rowCount: Array.isArray(rows) ? rows.length : 0,
      headerPreview: Array.isArray(rows) ? rows.slice(0, 3).map(compactRow) : [],
      layout: layoutSummary(layout),
    };
    stats.lastDirectInspection = diagnostic;
    if (inspection) stats.directInspectionSuccesses++;
    else stats.enrichmentPreflightSuccesses++;
    return { rows, layout, diagnostic };
  } catch (error) {
    const diagnostic = {
      ok: false,
      mode,
      spreadsheetId,
      sheetName: name,
      sheetId: gid,
      range,
      rowCount: Array.isArray(rows) ? rows.length : 0,
      headerPreview: Array.isArray(rows) ? rows.slice(0, 3).map(compactRow) : [],
      errorCode: error?.code || null,
      errorMessage: String(error?.message || error || '').slice(0, 1000),
    };
    stats.lastDirectInspection = diagnostic;
    if (inspection) stats.directInspectionFailures++;
    else stats.enrichmentPreflightFailures++;
    const wrapped = new Error(
      `Exact-tab ${mode} failed for '${name}' (${range}). Rows=${diagnostic.rowCount}; ` +
      `header=${JSON.stringify(diagnostic.headerPreview?.[0] || [])}; cause=${diagnostic.errorMessage}`
    );
    wrapped.code = error?.code === 'THREE_POC_LAYOUT_NOT_FOUND'
      ? 'THREE_POC_EXACT_TAB_LAYOUT_NOT_FOUND'
      : (error?.code || 'THREE_POC_EXACT_TAB_READ_FAILED');
    wrapped.diagnostic = diagnostic;
    throw wrapped;
  }
}

function inspectionFromDirectRead(source, result) {
  const layout = result.layout;
  return {
    compatible: true,
    provider: 'google',
    compatibleCount: 1,
    exactTabDirectInspection: true,
    readDiagnostic: result.diagnostic,
    sheets: [{
      sheetName: targetSheet(),
      sheetId: targetGid(source),
      schema: layout.schema,
      headerRowNumber: layout.headerRowNumber,
      linkedinIndex: layout.linkedinIndex,
      first: { ...layoutSummary(layout).first },
      second: { ...layoutSummary(layout).second },
      third: { ...layoutSummary(layout).third },
    }],
  };
}

async function withMetadataFallback(source, fn) {
  if (!enabled() || !targetSheet()) return fn();

  const originalMetadata = googleSheets.metadata;
  const originalSheetGid = googleSheets.sheetGid;
  const originalLinkedInHyperlinks = googleSheets.linkedInHyperlinks;
  const originalValues = googleSheets.values;
  const name = targetSheet();
  const gid = targetGid(source);
  stats.targetSheet = name;
  stats.targetGid = gid;

  googleSheets.metadata = async function metadataWithExactTabFallback(id) {
    stats.metadataAttempts++;
    try {
      const meta = await originalMetadata(id);
      const scoped = restrictMetadata(meta, name, gid);
      if (!scoped) {
        stats.targetMisses++;
        const error = new Error(`Configured target worksheet '${name}' was not present in Google Sheets metadata.`);
        error.code = 'THREE_POC_TARGET_TAB_NOT_FOUND';
        throw error;
      }
      stats.metadataScoped++;
      return scoped;
    } catch (error) {
      if (error?.code === 'THREE_POC_TARGET_TAB_NOT_FOUND') throw error;
      stats.metadataFallbacks++;
      stats.lastError = String(error?.message || error || '').slice(0, 500);
      return syntheticMetadata(id, name, gid);
    }
  };

  googleSheets.sheetGid = function exactConfiguredSheetGid() {
    if (gid != null) {
      stats.gidOverrides++;
      return Number(gid);
    }
    return originalSheetGid(source);
  };

  if (typeof originalValues === 'function') {
    googleSheets.values = async function diagnosticValues(id, range, ...rest) {
      stats.valuesReads++;
      stats.lastValuesRange = String(range || '');
      try {
        const rows = await originalValues(id, range, ...rest);
        stats.lastValuesRowCount = Array.isArray(rows) ? rows.length : 0;
        stats.lastHeaderPreview = Array.isArray(rows) ? rows.slice(0, 3).map(compactRow) : [];
        stats.lastValuesError = null;
        return rows;
      } catch (error) {
        stats.lastValuesError = String(error?.message || error || '').slice(0, 500);
        throw error;
      }
    };
  }

  if (typeof originalLinkedInHyperlinks === 'function') {
    googleSheets.linkedInHyperlinks = async function bestEffortLinkedInHyperlinks(...args) {
      stats.richLinkAttempts++;
      try {
        return await originalLinkedInHyperlinks(...args);
      } catch (error) {
        stats.richLinkFallbacks++;
        stats.lastRichLinkError = String(error?.message || error || '').slice(0, 500);
        return new Map();
      }
    };
  }

  try {
    return await fn();
  } finally {
    googleSheets.metadata = originalMetadata;
    googleSheets.sheetGid = originalSheetGid;
    googleSheets.values = originalValues;
    googleSheets.linkedInHyperlinks = originalLinkedInHyperlinks;
  }
}

function snapshot() {
  return {
    ...stats,
    lastHeaderPreview: stats.lastHeaderPreview.map((row) => [...row]),
    lastDirectInspection: stats.lastDirectInspection ? JSON.parse(JSON.stringify(stats.lastDirectInspection)) : null,
    enabled: enabled(),
  };
}

function install() {
  if (globalThis[INSTALL_FLAG]) return globalThis[INSTALL_FLAG];

  const baseEnrich = threePoc.enrichWorkbook.bind(threePoc);
  threePoc.enrichWorkbook = async function exactTabFallbackEnrich(source, options = {}) {
    return withMetadataFallback(source, async () => {
      await directExactTabRead(source, 'enrichment-preflight');
      return baseEnrich(source, options);
    });
  };

  // Approval inspection now comes directly from the exact configured worksheet.
  // No workbook scan, no local-XLSX fallback, no rich-link dependency.
  threePoc.inspectSource = async function exactTabFallbackInspect(source) {
    return withMetadataFallback(source, async () => {
      const direct = await directExactTabRead(source, 'inspection');
      return inspectionFromDirectRead(source, direct);
    });
  };

  const api = Object.freeze({
    installed: true,
    enabled,
    snapshot,
    targetSheet,
    targetGid,
    restrictMetadata,
    directExactTabRead,
    inspectionFromDirectRead,
  });
  globalThis[INSTALL_FLAG] = api;
  return api;
}

module.exports = {
  install,
  enabled,
  snapshot,
  targetSheet,
  targetGid,
  withMetadataFallback,
  restrictMetadata,
  directExactTabRead,
  inspectionFromDirectRead,
};
