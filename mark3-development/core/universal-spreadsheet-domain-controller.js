'use strict';

// First-class owner for spreadsheet contact enrichment. The normal execution
// path is intentionally model-free: schema inference, row planning, current-
// employer parsing, authority ranking and writes are all deterministic.
//
// Compatibility note: paid-tool approval resolution still enters through the
// existing lead-enrichment bootstrap. Until that bootstrap is fully migrated,
// this controller installs a narrow compatibility bridge over the legacy
// threePoc export so an already-approved `agentic-three-poc-enrichment` action
// executes the universal engine for Google Sheets. The bridge does NOT call the
// legacy AI selector and is removable once approval dispatch has a universal
// operation of its own.

const sheets = require('./google-sheets-operator');
const paidTools = require('./paid-tool-approval');
const universal = require('./universal-sheet-enrichment-targeted');
const legacyThreePoc = require('./three-poc-enrichment-operator');
const targetResolver = require('./universal-sheet-target-resolver');

const BRIDGE_FLAG = Symbol.for('ultron.mark3.universalSpreadsheetApprovalBridge.installed');
const REQUEST_FLAG = Symbol.for('ultron.mark3.universalSpreadsheetApprovalBridge.request');

function text(value) { return String(value == null ? '' : value).trim(); }

function parseSheetName(message) {
  const value = String(message || '');
  const linePatterns = [
    // Target only the `Gaurav 2` tab.
    /(?:^|\n)\s*(?:target|use)\s+(?:only\s+)?(?:the\s+)?[`"'“”]([^\n`"'“”]{1,120})[`"'“”]\s+(?:tab|sheet)\b/im,
    // Target only the Gaurav 2 tab.
    /(?:^|\n)\s*(?:target|use)\s+(?:only\s+)?(?:the\s+)?([^\n,.;]{1,120}?)\s+(?:tab|sheet)\b/im,
    /(?:^|\n)\s*(?:target|use|sheet|tab)\s+(?:only\s+)?(?:tab|sheet)?\s*[:=\-]\s*[`"'“”]?([^\n`"'“”]{1,120})/im,
    /(?:^|\n)\s*target\s+(?:only\s+)?(?:the\s+)?(?:tab|sheet)\s+["'`“”]?([^\n"'`“”]{1,120})/im,
    /\b(?:target|use)\s+(?:only\s+)?(?:the\s+)?(?:tab|sheet)\s+(?:named\s+)?["'`“”]?([^\n,.;"'`“”]{1,100})/i,
  ];
  for (const pattern of linePatterns) {
    const match = value.match(pattern);
    if (!match) continue;
    const candidate = text(match[1])
      .replace(/^[`"'“”]+|[`"'“”]+$/g, '')
      .replace(/[.]+$/, '')
      .trim();
    if (candidate && !/^(?:only|the|tab|sheet)$/i.test(candidate)) return candidate;
  }
  return '';
}

function configuredRowLimit() {
  const universalLimit = Number(process.env.ULTRON_M3_UNIVERSAL_ENRICHMENT_ROW_LIMIT || 0);
  if (Number.isFinite(universalLimit) && universalLimit > 0) return Math.floor(universalLimit);
  const legacyLimit = Number(process.env.ULTRON_M3_THREE_POC_ROW_LIMIT || 0);
  return Number.isFinite(legacyLimit) && legacyLimit > 0 ? Math.floor(legacyLimit) : undefined;
}

function rowLimitNotice(rowLimit) {
  const limit = Number(rowLimit || 0);
  if (Number.isFinite(limit) && limit > 0) {
    return `VALIDATION MODE IS ACTIVE: enrichment is capped to the first ${Math.floor(limit)} non-empty data rows by an environment row-limit. This is not a full-sheet run.`;
  }
  return 'FULL-SHEET MODE: no enrichment row-limit is active, so every non-empty data row is eligible for the pass.';
}

function response(ok, body, extra = {}) {
  return {
    ok,
    response: body,
    text: body,
    model: 'mark3-universal-deterministic-enrichment',
    provider: 'deterministic+apollo+google-sheets',
    taskType: 'universal-sheet-enrichment',
    mode: 'operator',
    toolRounds: 0,
    ...extra,
  };
}

function schemaReadable(summary = {}) {
  const people = Array.isArray(summary.personGroups) ? summary.personGroups.length : 0;
  const companies = Array.isArray(summary.companyGroups) ? summary.companyGroups.length : 0;
  const confidence = Number(summary.confidence || 0);
  return confidence >= 0.48 && (people > 0 || companies > 0);
}

function approvalSummary(inspection) {
  const schema = inspection?.analysis?.schema || inspection?.schema || {};
  const summary = require('./universal-enrichment-engine').schemaSummary(schema);
  const analysis = inspection?.analysis?.stats || {};
  const people = summary.personGroups?.length || 0;
  const companies = summary.companyGroups?.length || 0;
  const header = summary.headerRowNumber || '?';
  return [
    `ULTRON deterministically inspected worksheet "${inspection?.sheetName || '?'}" before Apollo approval.`,
    rowLimitNotice(inspection?.rowLimitApplied),
    `It detected header row ${header}, ${people} person/contact group${people === 1 ? '' : 's'} and ${companies} company group${companies === 1 ? '' : 's'} without assuming a fixed POC count or fixed column letters.`,
    `The planned pass contains ${analysis.openPersonSlots || 0} open and ${analysis.partialPersonSlots || 0} partial person/contact slots within the currently eligible row range.`,
    `Schema inference, employer parsing, authority ranking and column assignment use zero AI/model calls.`,
    `Apollo will be used only after approval for exact identity/contact discovery and hydration, and existing populated identities/contacts are preserved unless an exact verified same-person repair is safe.`,
  ].join(' ');
}

function installApprovalBridge() {
  if (globalThis[BRIDGE_FLAG]) return;
  const originalEnrich = legacyThreePoc.enrichWorkbook.bind(legacyThreePoc);
  const originalFormat = legacyThreePoc.formatResult.bind(legacyThreePoc);

  legacyThreePoc.enrichWorkbook = async function universalCompatibilityRun(url, options = {}) {
    const request = globalThis[REQUEST_FLAG];
    if (!request || request.url !== url || request.provider !== 'google') {
      return originalEnrich(url, options);
    }
    try {
      const result = await universal.run({
        sheetUrl: url,
        sheetName: request.sheetName || undefined,
        explicitNameAuthoritative: Boolean(request.explicitNameAuthoritative),
      }, {
        apolloApproved: true,
        rowLimit: request.rowLimit || options.rowLimit || undefined,
        allowLinkedInEmployerFallback: true,
      });
      return {
        ...result,
        rowLimitApplied: request.rowLimit || null,
        validationMode: Boolean(request.rowLimit),
      };
    } finally {
      globalThis[REQUEST_FLAG] = null;
    }
  };

  legacyThreePoc.formatResult = function universalCompatibilityFormat(result) {
    if (result?.deterministic === true && result?.modelCalls === 0 && result?.schema) {
      const formatted = universal.formatResult(result);
      if (Number(result?.rowLimitApplied || 0) > 0) {
        return `VALIDATION MODE: capped to the first ${Math.floor(Number(result.rowLimitApplied))} non-empty data rows. This was not a full-sheet run. ${formatted}`;
      }
      return `FULL-SHEET MODE: no row cap was active. ${formatted}`;
    }
    return originalFormat(result);
  };

  globalThis[BRIDGE_FLAG] = true;
}

installApprovalBridge();

async function resolveRequestedTarget(sheetUrl, requestedSheetName = '', options = {}) {
  const spreadsheetId = sheets.spreadsheetId(sheetUrl);
  const meta = await sheets.metadata(spreadsheetId);
  const resolution = targetResolver.resolveTabs(meta, sheetUrl, {
    sheetName: requestedSheetName || undefined,
    explicitNameAuthoritative: Boolean(options.explicitNameAuthoritative),
  });
  return {
    spreadsheetId,
    resolution,
    sheetName: resolution.target?.name || '',
    sheetId: resolution.target?.sheetId ?? null,
    targetSource: resolution.targetSource,
  };
}

async function inspect(sheetUrl, sheetName, rowLimit, options = {}) {
  const target = await resolveRequestedTarget(sheetUrl, sheetName, options);
  const inspection = await universal.run({
    sheetUrl,
    sheetName: target.sheetName || undefined,
    explicitNameAuthoritative: Boolean(options.explicitNameAuthoritative),
  }, {
    dryRun: true,
    rowLimit,
  });
  return {
    ...inspection,
    rowLimitApplied: rowLimit || null,
    validationMode: Boolean(rowLimit),
    requestedTarget: {
      sheetName: target.sheetName || null,
      sheetId: target.sheetId,
      source: target.targetSource,
      requestedGid: target.resolution.requestedGid,
      ignoredViewGid: target.resolution.ignoredViewGid,
      requestedName: target.resolution.requestedName || null,
    },
  };
}

async function handle(message, context = {}) {
  const original = String(context.originalMessage || message || '');
  const directSheetUrl = sheets.extractSheetUrl(original);
  const sheetUrl = directSheetUrl || sheets.extractSheetUrl(message);
  if (!sheetUrl) {
    return response(false,
      'Universal spreadsheet enrichment owns this command, but no full Google Sheets URL could be resolved. Nothing was edited and Apollo was not called.',
      { error: 'UNIVERSAL_SPREADSHEET_URL_REQUIRED', apolloCalled: false });
  }

  const requestedSheetName = parseSheetName(original);
  // When the user references a workbook through @mention/file attachment, the
  // resolved URL can retain whichever tab happened to be open. An explicit tab
  // name in the natural-language request must override that incidental view gid.
  // A directly pasted URL remains strict: name/gid disagreement fails closed.
  const explicitNameAuthoritative = Boolean(requestedSheetName && !directSheetUrl);
  const rowLimit = configuredRowLimit();
  let inspection;
  try {
    inspection = await inspect(sheetUrl, requestedSheetName, rowLimit, { explicitNameAuthoritative });
  } catch (error) {
    return response(false,
      `Universal spreadsheet inspection stopped safely: ${error.message} Nothing was edited and Apollo was not called.`,
      {
        error: error.code || 'UNIVERSAL_SPREADSHEET_INSPECTION_FAILED',
        apolloCalled: false,
        spreadsheetUrl: sheetUrl,
        sheetName: requestedSheetName || null,
        requestedGid: targetResolver.parseGid(sheetUrl),
      });
  }

  const exactSheetName = inspection.sheetName || inspection.requestedTarget?.sheetName || requestedSheetName || '';
  const summary = require('./universal-enrichment-engine').schemaSummary(inspection.schema || inspection.analysis?.schema || {});
  if (!schemaReadable(summary)) {
    return response(false,
      `ULTRON could not infer a sufficiently reliable person/company enrichment schema from worksheet "${exactSheetName || '?'}", so it refused to guess column relationships. Nothing was edited and Apollo was not called.`,
      { error: 'UNIVERSAL_SCHEMA_CONFIDENCE_TOO_LOW', apolloCalled: false, spreadsheetUrl: sheetUrl, sheetName: exactSheetName || null, schema: summary });
  }

  globalThis[REQUEST_FLAG] = {
    url: sheetUrl,
    provider: 'google',
    sheetName: exactSheetName,
    sheetId: inspection.requestedTarget?.sheetId ?? null,
    targetSource: inspection.requestedTarget?.source || 'none',
    explicitNameAuthoritative,
    rowLimit,
    schemaFingerprint: summary.fingerprint || null,
    requestedAt: new Date().toISOString(),
  };

  const approval = paidTools.request(
    'apollo',
    'agentic-three-poc-enrichment',
    { url: sheetUrl, provider: 'google', universal: true, sheetName: exactSheetName, rowLimit },
    approvalSummary(inspection),
  );

  return response(true, paidTools.prompt(approval), {
    model: 'apollo-approval-gate',
    provider: 'local-approval-gate',
    taskType: 'paid-tool-approval',
    paidToolApproval: { id: approval.id, tool: approval.tool, operation: approval.operation, expiresAt: approval.expiresAt },
    universalEnrichmentRequest: globalThis[REQUEST_FLAG],
    universalSchema: summary,
    universalAnalysis: inspection.analysis?.stats || null,
    spreadsheetUrl: sheetUrl,
    sheetName: exactSheetName || null,
    requestedTarget: inspection.requestedTarget || null,
    rowLimitApplied: rowLimit || null,
    validationMode: Boolean(rowLimit),
    deterministic: true,
    modelCalls: 0,
  });
}

module.exports = {
  handle,
  inspect,
  resolveRequestedTarget,
  parseSheetName,
  configuredRowLimit,
  rowLimitNotice,
  schemaReadable,
  approvalSummary,
  installApprovalBridge,
};
