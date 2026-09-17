'use strict';

// First-class one-run Apollo approval executor for universal Google-Sheet
// enrichment. Approval resolution itself is owned by command-control-plane;
// this module only validates and executes a resolved decision.

const paidTools = require('./paid-tool-approval');
const universal = require('./universal-sheet-enrichment-targeted');

const OPERATION = 'universal-spreadsheet-enrichment';

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

function modePrefix(rowLimit) {
  const limit = Number(rowLimit || 0);
  if (Number.isFinite(limit) && limit > 0) {
    return `VALIDATION MODE: capped to the first ${Math.floor(limit)} non-empty data rows. This was not a full-sheet run.`;
  }
  return 'FULL-SHEET MODE: no row cap was active.';
}

async function execute(decision) {
  if (!decision || decision.operation !== OPERATION || decision.tool !== 'apollo') return null;
  if (decision.status === 'denied') {
    return response(true, 'Apollo was not used, Sir. The universal spreadsheet enrichment run was cancelled.', {
      model: 'apollo-approval-gate',
      provider: 'local-approval-gate',
      taskType: 'paid-tool-approval',
      paidToolApproval: decision,
      apolloCalled: false,
    });
  }
  if (decision.status !== 'approved') return null;

  const payload = decision.payload || {};
  if (payload.provider !== 'google' || !payload.url || !payload.sheetName) {
    return response(false, 'Universal spreadsheet approval could not resolve its exact Google Sheet source, so Apollo was not called and nothing was edited.', {
      error: 'INVALID_UNIVERSAL_SPREADSHEET_SOURCE',
      paidToolApproval: decision,
      apolloCalled: false,
    });
  }

  try {
    const result = await paidTools.withPermit(decision, async () => universal.run({
      sheetUrl: payload.url,
      sheetName: payload.sheetName,
      sheetId: payload.sheetId ?? null,
      explicitNameAuthoritative: payload.explicitNameAuthoritative !== false,
    }, {
      apolloApproved: true,
      rowLimit: payload.rowLimit || undefined,
      allowLinkedInEmployerFallback: true,
    }));

    const enriched = {
      ...result,
      rowLimitApplied: payload.rowLimit || null,
      validationMode: Boolean(payload.rowLimit),
    };
    const body = `${modePrefix(payload.rowLimit)} ${universal.formatResult(enriched)}`;
    const modelCalls = Number(result?.modelCalls || 0);
    const fallbackUsed = modelCalls > 0;
    return response(true, body, {
      universalEnrichment: enriched,
      spreadsheetProvider: 'google',
      spreadsheetUrl: payload.url,
      sheetName: result.sheetName || payload.sheetName,
      paidToolApproval: decision,
      deterministicPrimary: true,
      deterministic: !fallbackUsed,
      fallbackModelUsed: fallbackUsed,
      modelCalls,
      provider: fallbackUsed ? 'deterministic+apollo+google-sheets+omniroute/opencode' : 'deterministic+apollo+google-sheets',
    });
  } catch (error) {
    const code = error.code || 'UNIVERSAL_SPREADSHEET_EXECUTION_FAILED';
    return response(false, `Universal spreadsheet enrichment stopped safely: ${code}: ${error.message || 'unknown execution failure'}.`, {
      error: code,
      errorCode: code,
      errorMessage: error.message || '',
      diagnostic: `${code}: ${error.message || 'unknown execution failure'}`,
      spreadsheetProvider: 'google',
      spreadsheetUrl: payload.url,
      sheetName: payload.sheetName,
      paidToolApproval: decision,
    });
  }
}

// Kept as an explicit hook for callers/self-tests. There is intentionally no
// assistant.handle monkey-patch anymore; command-control-plane resolves approval.
function install() {
  return Object.freeze({ installed: true, operation: OPERATION, owner: 'command-control-plane' });
}

module.exports = { OPERATION, install, execute, modePrefix };
