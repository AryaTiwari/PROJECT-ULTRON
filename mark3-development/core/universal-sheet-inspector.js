'use strict';

// Pre-approval inspection is cheap, deterministic and side-effect free: it
// reads the exact worksheet and resolves the CANONICAL schema through the very
// same path approved execution uses (operator.readUniversalSheet), so the
// approval-time schema and the execution-time schema are the same resolution —
// no pipeline stage reinterprets headers independently (Phase 2/13).
// The rich-hyperlink probe is a bounded read-only GET over LinkedIn columns;
// it never writes, never calls Apollo and never calls a model.

require('./universal-deterministic-bootstrap').install();

const sheets = require('./google-sheets-operator');
const engine = require('./universal-enrichment-engine');
const operator = require('./universal-sheet-enrichment-operator');

function stagedError(code, stage, error, extra = {}) {
  const original = error instanceof Error ? error : new Error(String(error || 'unknown failure'));
  if (original.code && String(original.code).startsWith('GOOGLE_SHEETS_')) {
    original.stage = original.stage || stage;
    Object.assign(original, extra);
    return original;
  }
  const wrapped = new Error(`${stage}: ${original.message || 'unknown failure'}`);
  wrapped.code = code;
  wrapped.stage = stage;
  wrapped.cause = original;
  Object.assign(wrapped, extra);
  return wrapped;
}

async function inspectExact({ spreadsheetId, spreadsheetTitle = '', sheetName, sheetId = null, rowLimit, schemaOptions = {} } = {}) {
  if (!spreadsheetId || !sheetName) {
    const error = new Error('Exact spreadsheetId and sheetName are required for universal inspection.');
    error.code = 'UNIVERSAL_INSPECTION_TARGET_REQUIRED';
    throw error;
  }

  let source;
  try {
    source = await operator.readUniversalSheet(`https://docs.google.com/spreadsheets/d/${spreadsheetId}`, {
      sheetName,
      sheetId,
      explicitNameAuthoritative: true,
      schema: schemaOptions || {},
      expectedPersonGroups: Number(schemaOptions?.expectedPersonGroups || 0) || undefined,
    });
  } catch (error) {
    if (error?.code && String(error.code).startsWith('GOOGLE_SHEETS_')) {
      throw stagedError('UNIVERSAL_SHEET_VALUES_READ_FAILED', 'sheet-values-read', error, { spreadsheetId, sheetName, sheetId });
    }
    if (error?.code && String(error.code).startsWith('UNIVERSAL_SCHEMA')) {
      throw stagedError('UNIVERSAL_SHEET_PLANNING_FAILED', 'schema-inference-and-row-planning', error, { spreadsheetId, sheetName, sheetId });
    }
    throw error;
  }

  const rows = source.rows;

  let analysis;
  try {
    analysis = engine.analyzeSheet(rows, { rowLimit, schema: schemaOptions, resolvedSchema: source.schema });
  } catch (error) {
    throw stagedError('UNIVERSAL_SHEET_PLANNING_FAILED', 'schema-inference-and-row-planning', error, { spreadsheetId, sheetName, sheetId });
  }

  let schema;
  try {
    schema = engine.schemaSummary(analysis.schema);
  } catch (error) {
    throw stagedError('UNIVERSAL_SCHEMA_SUMMARY_FAILED', 'schema-summary', error, { spreadsheetId, sheetName, sheetId });
  }

  return {
    ok: true,
    dryRun: true,
    deterministic: true,
    modelCalls: 0,
    spreadsheetId: source.spreadsheetId || spreadsheetId,
    spreadsheetTitle: source.spreadsheetTitle || spreadsheetTitle,
    sheetName: source.sheetName || sheetName,
    sheetId: source.sheetId ?? sheetId,
    sheetTargetMatchedBy: source.sheetTargetMatchedBy || null,
    rows,
    analysis,
    schema,
    stats: {
      rowsSeen: analysis.stats?.dataRows || 0,
      modelCalls: 0,
    },
    inspectionMode: 'unified-canonical-preapproval',
    richHyperlinkProbe: true,
  };
}

module.exports = { inspectExact, stagedError };
