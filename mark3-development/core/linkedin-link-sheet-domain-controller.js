'use strict';

// Dedicated controller for LinkedIn URL backfilling.
// It shares deterministic sheet targeting/schema inspection with the universal
// subsystem, but its execution path is isolated and never enters Apollo POC
// enrichment, paid approval, or the universal enrichment operator.

const sheets = require('./google-sheets-operator');
const universalSheetController = require('./universal-spreadsheet-domain-controller');
const linkEnricher = require('./linkedin-link-sheet-enricher');
const runtimeBuild = require('./runtime-build');

function response(ok, body, extra = {}) {
  const stamped = `${String(body || '').trim()}\\n\\n[linkedin-sheet-links · build ${String(runtimeBuild.revision || '').slice(0, 8) || 'unknown'} · src ${runtimeBuild.fingerprint}]`;
  return {
    ok,
    response: stamped,
    text: stamped,
    model: 'mark3-linkedin-link-enricher',
    provider: 'fastmcp-linkedin+google-sheets',
    taskType: 'linkedin-sheet-link-enrichment',
    mode: 'isolated-operator',
    toolRounds: 0,
    runtimeBuildId: runtimeBuild.id,
    runtimeRevision: runtimeBuild.revision,
    runtimeSourceFingerprint: runtimeBuild.fingerprint,
    apolloCalled: false,
    ...extra,
  };
}

async function handle(message, context = {}) {
  const original = String(context.originalMessage || message || '');
  const sheetUrl = sheets.extractSheetUrl(original) || sheets.extractSheetUrl(message);
  if (!sheetUrl) {
    return response(false,
      'LinkedIn link enrichment stopped safely: no full Google Sheets URL could be resolved. Nothing was edited.',
      {
        error: 'LINKEDIN_LINK_SHEET_URL_REQUIRED',
        errorSubsystem: 'TARGETING',
        errorType: 'CONFIG',
      });
  }

  const requestedSheetName = universalSheetController.parseSheetName(original);
  const rowLimit = universalSheetController.configuredRowLimit(original);
  let inspection;

  try {
    inspection = await universalSheetController.inspect(sheetUrl, requestedSheetName, rowLimit, {
      explicitNameAuthoritative: Boolean(requestedSheetName),
      sourceText: original,
      schema: {},
    });
  } catch (error) {
    return response(false,
      `LinkedIn link enrichment stopped safely during sheet inspection: ${String(error?.message || error)} Nothing was edited.`,
      {
        error: error?.code || 'LINKEDIN_LINK_SHEET_INSPECTION_FAILED',
        errorSubsystem: error?.subsystem || 'GOOGLE_SHEETS',
        errorType: error?.errorType || 'API',
        sheetName: error?.sheetName || requestedSheetName || null,
        spreadsheetUrl: sheetUrl,
      });
  }

  const source = {
    spreadsheetId: inspection.spreadsheetId,
    spreadsheetTitle: inspection.spreadsheetTitle,
    sheetName: inspection.sheetName,
    sheetId: inspection.sheetId,
    rows: inspection.rows.map((row) => row.slice()),
    schema: inspection.analysis?.schema,
  };

  if (!source.schema) {
    return response(false,
      'LinkedIn link enrichment stopped safely: deterministic spreadsheet schema was unavailable. Nothing was edited.',
      {
        error: 'LINKEDIN_LINK_SCHEMA_UNAVAILABLE',
        errorSubsystem: 'SCHEMA',
        errorType: 'SCHEMA',
        sheetName: inspection.sheetName,
      });
  }

  try {
    const result = await linkEnricher.run(source, {
      rowLimit,
      sheetsApi: context.sheetsApi,
      linkedinMcp: context.linkedinMcp,
    });

    if (!result.activated) {
      return response(true,
        `LinkedIn link enrichment checked worksheet "${inspection.sheetName}" and found no eligible gaps. A row must contain a company or POC name while its corresponding LinkedIn link is blank. No LinkedIn provider calls and no writes were made.`,
        {
          sheetName: inspection.sheetName,
          spreadsheetUrl: sheetUrl,
          activated: false,
          noOp: true,
          stats: result.stats,
          plan: result.plan,
        });
    }

    return response(true,
      `LinkedIn link enrichment completed on worksheet "${inspection.sheetName}". Filled ${result.stats.companyLinksFilled} company LinkedIn link${result.stats.companyLinksFilled === 1 ? '' : 's'} and ${result.stats.personLinksFilled} POC LinkedIn link${result.stats.personLinksFilled === 1 ? '' : 's'}. Existing non-blank links were preserved.`,
      {
        sheetName: inspection.sheetName,
        spreadsheetUrl: sheetUrl,
        activated: true,
        stats: result.stats,
        plan: result.plan,
        writes: result.writes,
        apolloCalls: 0,
      });
  } catch (error) {
    return response(false,
      `LinkedIn link enrichment stopped safely: ${String(error?.message || error)} Existing non-blank LinkedIn cells were never targeted for overwrite.`,
      {
        error: error?.code || 'LINKEDIN_LINK_ENRICHER_FAILED',
        errorSubsystem: error?.subsystem || 'LINKEDIN',
        errorType: error?.errorType || 'API',
        sheetName: inspection.sheetName,
        spreadsheetUrl: sheetUrl,
      });
  }
}

module.exports = { handle };
