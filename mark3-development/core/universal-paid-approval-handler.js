'use strict';

// First-class one-run Apollo approval executor for universal Google-Sheet
// enrichment. Approval resolution itself is owned by command-control-plane;
// this module only validates and executes a resolved decision.

const paidTools = require('./paid-tool-approval');
const deterministicBootstrap = require('./universal-deterministic-bootstrap');
const universal = require('./universal-sheet-enrichment-targeted');
const typedErrors = require('./spreadsheet-enrichment-errors');

const OPERATION = 'universal-spreadsheet-enrichment';
const EXECUTION_CONTRACT = 'universal-coordinated-multi-poc-v4';

function response(ok, body, extra = {}) {
  return {
    ok,
    response: body,
    text: body,
    model: 'mark3-universal-bounded-ai-enrichment',
    provider: 'deterministic+apollo+google-sheets+bounded-ai-rescue',
    taskType: 'universal-sheet-enrichment',
    mode: 'operator',
    toolRounds: 0,
    executionContract: EXECUTION_CONTRACT,
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
    const typed = typedErrors.normalize(Object.assign(new Error('Universal spreadsheet approval could not resolve its exact Google Sheet source.'), {
      code: 'INVALID_UNIVERSAL_SPREADSHEET_SOURCE',
      subsystem: 'TARGETING',
      errorType: 'CONFIG',
      stage: 'approved-source-validation',
    }));
    return response(false, `Universal spreadsheet enrichment stopped safely: ${typedErrors.format(typed)}. ${typed.hint}`, {
      error: typed.code,
      errorCode: typed.code,
      errorSubsystem: typed.subsystem,
      errorType: typed.type,
      errorStage: typed.stage,
      errorHint: typed.hint,
      errorMessage: typed.message,
      diagnostic: typedErrors.format(typed),
      paidToolApproval: decision,
      apolloCalled: false,
    });
  }

  try {
    // Approval re-entry is resolved before ordinary spreadsheet controller routing,
    // so never assume an earlier controller import installed deterministic hardening.
    deterministicBootstrap.install();

    const executionMode = payload.contactPhaseOrdinal
      ? `POC-${Number(payload.contactPhaseOrdinal)} diagnostic`
      : 'coordinated multi-POC production';
    const result = await paidTools.withPermit(decision, async () => universal.run({
      sheetUrl: payload.url,
      sheetName: payload.sheetName,
      sheetId: payload.sheetId ?? null,
      explicitNameAuthoritative: payload.explicitNameAuthoritative !== false,
    }, {
      apolloApproved: true,
      expectedSchemaFingerprint: payload.schemaFingerprint || undefined,
      rowLimit: payload.rowLimit || undefined,
      schema: payload.expectedPersonGroups ? { expectedPersonGroups: payload.expectedPersonGroups } : {},
      expectedPersonGroups: payload.expectedPersonGroups || undefined,
      allowLinkedInEmployerFallback: true,
      // Give pending callbacks one immediate check, then let the durable watcher
      // settle remaining exact-owned cells without holding the chat response.
      backgroundFirstPendingContacts: !payload.rowLimit,
      // Explicit "POC-N only" requests stay isolated for diagnostics. Ordinary
      // enrichment returns to the coordinated all-POC production path so bounded
      // Gemini/Groq/NVIDIA rescue can operate after deterministic enrichment.
      pocPhasePipeline: Boolean(payload.contactPhaseOrdinal),
      contactPhaseOrdinal: payload.contactPhaseOrdinal || undefined,
    }));

    const enriched = {
      ...result,
      rowLimitApplied: payload.rowLimit || null,
      validationMode: Boolean(payload.rowLimit),
    };

    let body;
    let reportFormattingError = null;
    try {
      body = `${modePrefix(payload.rowLimit)} EXECUTION MODE: ${executionMode}. ${universal.formatResult(enriched)}`;
    } catch (error) {
      if (!error?.code) error.code = 'UNIVERSAL_RESULT_FORMAT_FAILED';
      if (!error?.subsystem) error.subsystem = 'UNIVERSAL';
      if (!error?.errorType) error.errorType = 'INTERNAL';
      if (!error?.stage) error.stage = 'result-formatting';
      const typed = typedErrors.normalize(error, { stage: 'result-formatting' });
      reportFormattingError = {
        code: typed.code,
        subsystem: typed.subsystem,
        type: typed.type,
        stage: typed.stage,
        message: typed.message,
        hint: typed.hint,
      };
      const s = result?.stats || {};
      body = `${modePrefix(payload.rowLimit)} Universal enrichment execution returned safely, but the report formatter had a problem. ${typedErrors.format(typed)} Earlier verified writes were preserved. Processed ${s.rowsProcessed || 0}/${s.rowsSeen || 0} rows and changed ${s.cellsChanged || 0} cells across ${s.rowsChanged || 0} rows. Resume-safe: yes.`;
    }

    const modelCalls = Number(result?.modelCalls || 0);
    const fallbackUsed = modelCalls > 0;
    const partialCompletion = Boolean(
      result?.partialCompletion
      || result?.stats?.haltedEarly
      || result?.bigPickleFallback?.haltedEarly
      || result?.postPrimaryError
      || reportFormattingError
    );
    return response(true, body, {
      universalEnrichment: enriched,
      spreadsheetProvider: 'google',
      spreadsheetUrl: payload.url,
      sheetName: result.sheetName || payload.sheetName,
      paidToolApproval: decision,
      deterministicPrimary: true,
      deterministic: !fallbackUsed,
      fallbackModelUsed: fallbackUsed,
      boundedAiBatchRescue: Boolean(result?.aiBatchRescue?.attempted),
      boundedAiBatchMaxCalls: Number(result?.aiBatchRescue?.maxCalls || 0),
      expectedPersonGroups: payload.expectedPersonGroups || null,
      executionMode,
      contactPhaseOrdinal: payload.contactPhaseOrdinal || null,
      modelCalls,
      completedFully: !partialCompletion,
      partialCompletion,
      resumeSafe: result?.resumeSafe !== false,
      haltError: result?.stats?.haltError || result?.bigPickleFallback?.haltError || result?.bigPickleFallback?.error || result?.postPrimaryError || reportFormattingError || null,
      postPrimaryError: result?.postPrimaryError || null,
      reportFormattingError,
      rowFailureAudit: result?.stats?.rowFailureAudit || [],
      provider: fallbackUsed ? 'deterministic+apollo+google-sheets+bounded-direct-env-ai' : 'deterministic+apollo+google-sheets',
    });
  } catch (error) {
    // Preserve provider/network semantics before applying any universal fallback.
    // Raw transport errors such as "Failed to fetch" must become typed NETWORK
    // failures rather than being mislabeled INTERNAL by the approval boundary.
    if (!error?.stage) error.stage = 'approved-enrichment-execution';
    const typed = typedErrors.normalize(error, {
      stage: error?.stage || 'approved-enrichment-execution',
    });
    if (typed.code === 'UNIVERSAL_INTERNAL_UNCLASSIFIED') {
      typed.code = 'UNIVERSAL_APPROVED_EXECUTION_LOCAL_FAILURE';
      typed.subsystem = typed.subsystem || 'UNIVERSAL';
      typed.type = typed.type || 'INTERNAL';
    }
    const diagnostic = typedErrors.format(typed);
    return response(false, `Universal spreadsheet enrichment stopped safely: ${diagnostic}. ${typed.hint}`, {
      error: typed.code,
      errorCode: typed.code,
      errorSubsystem: typed.subsystem,
      errorType: typed.type,
      errorStage: typed.stage,
      errorHint: typed.hint,
      errorMessage: typed.message,
      diagnostic,
      retryAttempts: typed.retryAttempts,
      attemptedRange: typed.attemptedRange || null,
      endpoint: typed.endpoint || null,
      providerStatus: typed.providerStatus ?? typed.status ?? null,
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

module.exports = { OPERATION, EXECUTION_CONTRACT, install, execute, modePrefix };
