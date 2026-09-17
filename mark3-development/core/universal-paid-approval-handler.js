'use strict';

// First-class one-run Apollo approval handler for universal Google-Sheet
// enrichment. This deliberately sits outside the legacy 3-POC approval path.

const paidTools = require('./paid-tool-approval');
const universal = require('./universal-sheet-enrichment-targeted');

const OPERATION = 'universal-spreadsheet-enrichment';
const INSTALL_FLAG = Symbol.for('ultron.mark3.universalPaidApprovalHandler.installed');

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
    return response(true, body, {
      universalEnrichment: enriched,
      spreadsheetProvider: 'google',
      spreadsheetUrl: payload.url,
      sheetName: result.sheetName || payload.sheetName,
      paidToolApproval: decision,
      deterministic: true,
      modelCalls: 0,
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

function install() {
  if (globalThis[INSTALL_FLAG]) return globalThis[INSTALL_FLAG];
  const assistant = require('./assistant');
  if (!assistant?.handle) throw new Error('Assistant handle is unavailable for universal paid approval handling.');
  const originalHandle = assistant.handle.bind(assistant);

  assistant.handle = async function universalPaidApprovalAwareHandle(message, options = {}) {
    const pending = paidTools.pending('apollo');
    if (!pending || pending.operation !== OPERATION) return originalHandle(message, options);

    const decision = paidTools.resolveMessage(String(message || ''));
    if (!decision) return originalHandle(message, options);
    const handled = await execute(decision);
    return handled || originalHandle(message, options);
  };

  const api = Object.freeze({ installed: true, operation: OPERATION });
  globalThis[INSTALL_FLAG] = api;
  return api;
}

module.exports = { OPERATION, install, execute, modePrefix };
