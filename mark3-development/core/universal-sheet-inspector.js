'use strict';

// Pre-approval inspection must be cheap, deterministic and side-effect free.
// It reads the exact worksheet values and infers/plans the schema, but deliberately
// does not probe rich hyperlinks, LinkedIn, Apollo or any model API.

require('./universal-deterministic-bootstrap').install();

const sheets = require('./google-sheets-operator');
const engine = require('./universal-enrichment-engine');

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

  let rows;
  try {
    rows = await sheets.values(spreadsheetId, `${sheets.quoteSheet(sheetName)}!A:ZZ`);
  } catch (error) {
    throw stagedError('UNIVERSAL_SHEET_VALUES_READ_FAILED', 'sheet-values-read', error, { spreadsheetId, sheetName, sheetId });
  }

  let analysis;
  try {
    analysis = engine.analyzeSheet(rows, { rowLimit, schema: schemaOptions });
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
    spreadsheetId,
    spreadsheetTitle,
    sheetName,
    sheetId,
    rows,
    analysis,
    schema,
    stats: {
      rowsSeen: analysis.stats?.dataRows || 0,
      modelCalls: 0,
    },
    inspectionMode: 'values-only-preapproval',
    richHyperlinkProbe: false,
  };
}

module.exports = { inspectExact, stagedError };
