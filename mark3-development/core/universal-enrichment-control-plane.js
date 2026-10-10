'use strict';

const missions = require('./universal-enrichment-mission-store');
const paidTools = require('./paid-tool-approval');
const rowSelection = require('./universal-row-selection');

missions.markInterruptedOnStartup();

const text = (v) => String(v ?? '').trim();

function isResume(value) {
  const v = text(value);
  return /^(?:resume|continue)(?:\s+(?:the|my|latest|current|apollo|poc|lead|spreadsheet))?\s*(?:enrichment)?\s*[.!]?$/i.test(v)
    || /\b(?:resume|continue)\s+(?:apollo|poc|spreadsheet|lead)\s+enrichment\b/i.test(v);
}

function isRetryUnresolved(value) {
  const v = text(value);
  return /^(?:retry|backfill)(?:\s+(?:the|my|latest|current))?\s+(?:unresolved|failed|incomplete)(?:\s+(?:enrichment|rows?|pocs?))?\s*[.!]?$/i.test(v)
    || /\b(?:retry|backfill)\s+(?:unresolved|failed|incomplete)\s+(?:enrichment|rows?|pocs?)\b/i.test(v);
}

function isStatus(value) {
  return /^\s*(?:universal\s+)?enrichment\s+(?:status|progress)\s*[.!]?$/i.test(text(value));
}

function isHealth(value) {
  return /^\s*enrichment\s+health\s*[.!]?$/i.test(text(value));
}

function isControlRequest(value) {
  return isStatus(value) || isHealth(value) || isResume(value) || isRetryUnresolved(value);
}

function response(body, extra = {}) {
  return {
    ok: true,
    response: body,
    text: body,
    model: 'universal-enrichment-control-plane',
    provider: 'local-durable-mission-store',
    taskType: 'universal-enrichment-control',
    mode: 'operator',
    toolRounds: 0,
    apolloCalled:false,
    ...extra,
  };
}

function scopeText(mission) {
  const scope = mission?.writeScope;
  return scope?.allowed?.length
    ? [...new Set(scope.allowed.map((x) => `POC-${x.ordinal} ${x.field}`))].join(', ')
    : 'legacy validated enrichment scope';
}

function format(m) {
  if (!m) return 'No universal spreadsheet-enrichment mission is available.';

  const ledger = m.apolloUsageLedger || {};
  const rows = Object.values(m.rowCheckpoints || {});
  const done = Number(m.rowsProcessed || 0);
  const total = Number(m.totalEligibleRows || 0);
  const remaining = Math.max(0, Number(m.rowsRemaining ?? total - done));
  const partial = rows.filter((row) => !row.processed && row.state && row.state !== 'UNTOUCHED').length;
  const poc = {};
  let pendingPhones = 0;

  for (const row of rows) {
    for (const [ordinal, slot] of Object.entries(row.slots || {})) {
      poc[ordinal] = poc[ordinal] || { complete: 0, partial: 0 };
      if (slot.state === 'COMPLETE') poc[ordinal].complete++;
      else poc[ordinal].partial++;
      for (const field of Object.values(slot.fields || {})) {
        if (['PENDING', 'PHONE_PENDING'].includes(field.state)) pendingPhones++;
      }
    }
  }

  const elapsed = m.startedAt ? Math.max(1, (Date.now() - Date.parse(m.startedAt)) / 60000) : 0;
  const speed = elapsed ? Math.round(done / elapsed) : 0;
  const provider = m.providerState?.apollo?.state || 'CLOSED';
  const lines = [
    `MISSION ${m.missionId}`,
    `Sheet: ${m.spreadsheetTitle || m.spreadsheetId || 'unknown'}`,
    `Worksheet: ${m.sheetName || 'unknown'}${m.sheetId != null ? ` (id ${m.sheetId})` : ''}`,
    `State: ${m.status}`,
    `Policy: ${m.policyMode || 'hiring-authority'}${m.policyIndiaRequired ? ' (India phone required)' : ''}${m.policySource ? ` via ${m.policySource}` : ''}`,
    `Rows: ${done} processed; ${partial} partial; ${remaining} remaining; ${total || '?'} total`,
    `Forward frontier: last ${m.lastProcessedRow ?? 'none'}; next ${m.nextRow ?? m.startRow ?? 'unknown'}; end ${m.endRow ?? 'unknown'}`,
  ];

  for (const ordinal of Object.keys(poc).sort((a, b) => Number(a) - Number(b))) {
    lines.push(`POC-${ordinal}: ${poc[ordinal].complete} complete; ${poc[ordinal].partial} partial`);
  }

  lines.push(
    `Apollo: ${ledger.discoveryCalls || 0} discovery; ${ledger.discoveryCacheHits || 0} cache hits; ${ledger.personHydrations || 0} hydrations; ${ledger.phoneReveals || 0} phone reveals; ${ledger.rateLimits || 0} rate limits`,
    `Speed: ${speed || 0} rows/min`,
    `Pending phone callbacks: ${pendingPhones}`,
    `Provider health: Apollo ${provider.toLowerCase()}`,
    `Checkpoint: ${m.lastSafeCheckpoint?.rowNumber ? `row ${m.lastSafeCheckpoint.rowNumber}` : 'none yet'}`,
    `Write scope: ${scopeText(m)}`,
    m.nextEligibleAt
      ? `Next eligible retry: ${new Date(m.nextEligibleAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST (${m.nextEligibleAtSource || 'local policy'})`
      : 'Next action: ' + (m.status === 'AWAITING_APOLLO_APPROVAL' ? 'approve Apollo once for the saved mission' : 'continue remaining work'),
  );

  return lines.join('\n');
}

function health() {
  const google = require('./google-sheets-auth').status();
  const apollo = require('./apollo-enrichment').status();
  const circuits = require('./universal-provider-circuit-breaker').status();
  const mission = missions.latestResumable() || missions.latest();
  let pending = 0;
  try {
    pending = require('./universal-sheet-enrichment-operator').backgroundPhonePendingCount?.() || 0;
  } catch {}

  const state = {
    googleSheets: google.authorized ? 'healthy' : (google.hasRefreshToken ? 'auth-recoverable' : 'unavailable'),
    apollo: circuits.apollo?.state === 'OPEN' ? 'cooldown' : (apollo.apiKeyReady ? 'healthy' : 'unavailable'),
    linkedin: circuits.linkedin?.state === 'OPEN' ? 'cooldown' : 'available',
    directAi: (
      process.env.GEMINI_API_KEY
      || process.env.GEMINI_API_KEY2
      || process.env.GROK_API_KEY
      || process.env.GROK_API_KEY2
      || process.env.GROQ_API_KEY
      || process.env.GROQ_API_KEY2
      || process.env.NVIDIA_API_KEY
    ) ? 'healthy' : 'unused',
    missionStore: 'healthy',
    policyMode: mission?.policyMode || 'hiring-authority',
    checkpoint: mission?.lastSafeCheckpoint ? 'healthy' : 'empty',
    writeFirewall: 'armed',
    pendingPhoneCallbacks: pending,
    currentMission: mission?.missionId || null,
    nextEligibleAt: circuits.apollo?.nextEligibleAt || mission?.nextEligibleAt || null,
    apolloCalls: 0,
  };

  return response([
    'Enrichment health',
    `Google Sheets: ${state.googleSheets}`,
    `Apollo: ${state.apollo}`,
    `LinkedIn: ${state.linkedin}`,
    `Direct AI: ${state.directAi}`,
    `Mission store: ${state.missionStore}`,
    `Selection policy: ${state.policyMode}`,
    `Checkpoint: ${state.checkpoint}`,
    `Write firewall: ${state.writeFirewall}`,
    `Pending phone callbacks: ${state.pendingPhoneCallbacks}`,
    `Current mission: ${state.currentMission || 'none'}`,
    state.nextEligibleAt
      ? `Next eligible retry: ${new Date(state.nextEligibleAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`
      : 'Next eligible retry: now',
  ].join('\n'), { enrichmentHealth: state });
}

function eligibleRows(inspection) {
  return (inspection.analysis?.rowPlans || [])
    .map((plan) => Number(plan?.rowNumber))
    .filter(Number.isInteger)
    .sort((a, b) => a - b);
}

function scopeColumnIndexes(mission) {
  return [...new Set(
    (mission.writeScope?.allowed || [])
      // Supporting owner-identity fields may be writable when creating a new
      // POC slot, but they are not evidence that a contact-enrichment pass has
      // already reached that row. Resume recovery must follow the fields the
      // user actually requested (for this incident: phone/email).
      .filter((item) => item?.supporting !== true)
      .map((item) => Number(item.columnIndex))
      .filter(Number.isInteger),
  )];
}

function rowHasScopedValue(inspection, rowNumber, columns) {
  const row = inspection.rows?.[rowNumber - 1] || [];
  return columns.some((columnIndex) => {
    const value = text(row[columnIndex]);
    return Boolean(value && !/^null$/i.test(value));
  });
}

function recoverForwardFrontier(mission, inspection) {
  const allRows = eligibleRows(inspection);
  const endRow = allRows.at(-1) || mission.endRow || null;

  const savedNext = Number(mission.nextRow);
  const savedLast = Number(mission.lastProcessedRow);
  if (Number.isInteger(savedNext) && Number.isInteger(savedLast)) {
    return {
      lastProcessedRow: savedLast,
      nextRow: savedNext,
      endRow,
      source: mission.frontierSource || 'durable-mission-frontier',
    };
  }

  const checkpointFrontier = missions.frontierFromRows(mission.rowCheckpoints || {});
  if (Number.isInteger(checkpointFrontier)) {
    return {
      lastProcessedRow: checkpointFrontier,
      nextRow: checkpointFrontier + 1,
      endRow,
      source: 'durable-row-checkpoints',
    };
  }

  // Legacy mission recovery: infer only from columns that the universal mission
  // is actually allowed to write. Dedicated LinkedIn/APOLLO columns, Outcome,
  // notes, and all protected columns are deliberately invisible here.
  const columns = scopeColumnIndexes(mission);
  const touchedRows = columns.length
    ? allRows.filter((rowNumber) => rowHasScopedValue(inspection, rowNumber, columns))
    : [];
  const lastScopedValueRow = touchedRows.at(-1) || null;

  if (Number.isInteger(lastScopedValueRow)) {
    return {
      lastProcessedRow: lastScopedValueRow,
      nextRow: lastScopedValueRow + 1,
      endRow,
      source: 'sheet-write-scope-recovery',
    };
  }

  const first = allRows[0] || mission.startRow || null;
  return {
    lastProcessedRow: null,
    nextRow: first,
    endRow,
    source: 'mission-start',
  };
}

async function inspectMission(mission) {
  const domain = require('./universal-spreadsheet-domain-controller');
  try {
    const inspection = await domain.inspect(
      mission.spreadsheetUrl,
      mission.sheetName,
      mission.request?.rowLimit || undefined,
      {
        explicitNameAuthoritative: true,
        sourceText: mission.request?.originalMessage || '',
        schema: mission.request?.expectedPersonGroups
          ? { expectedPersonGroups: mission.request.expectedPersonGroups }
          : {},
      },
    );

    if (mission.sheetId != null && Number(inspection.sheetId) !== Number(mission.sheetId)) {
      throw Object.assign(
        new Error('The saved worksheet identity no longer matches the live worksheet.'),
        { code: 'UNIVERSAL_RESUME_TARGET_MISMATCH' },
      );
    }

    if (mission.schemaFingerprint
      && inspection.schema?.fingerprint !== mission.schemaFingerprint
      && inspection.schema?.structuralFingerprint !== mission.schemaFingerprint) {
      missions.update(mission.missionId, {
        status: 'FAILED_SAFE',
        completionState: 'FAILED_SAFE',
        lastError: { type: 'SCHEMA', code: 'UNIVERSAL_RESUME_SCHEMA_CHANGED' },
      });
      throw Object.assign(
        new Error('The worksheet schema changed after the checkpoint. Reinspect before continuing.'),
        { code: 'UNIVERSAL_RESUME_SCHEMA_CHANGED' },
      );
    }

    return inspection;
  } catch (error) {
    missions.update(mission.missionId, {
      status: 'FAILED_SAFE',
      completionState: 'FAILED_SAFE',
      lastError: require('./universal-enrichment-recovery').classify(error, { stage: 'resume-preflight' }),
    });
    throw error;
  }
}

function requestApproval(mission, inspection, targetSelection, summary, targetCount = null) {
  const selection = rowSelection.normalize(targetSelection);
  const count = Number.isInteger(Number(targetCount)) && Number(targetCount) >= 0
    ? Number(targetCount)
    : Number(selection?.count || 0);
  const payload = {
    ...(mission.request || {}),
    url: mission.spreadsheetUrl,
    sheetName: inspection.sheetName,
    sheetId: inspection.sheetId,
    schemaFingerprint: inspection.schema.fingerprint,
    missionId: mission.missionId,
    writeScope: mission.writeScope,
    apolloBudget: mission.budget,
    targetRowSelection: selection,
  };
  delete payload.targetRows;

  const approval = paidTools.request(
    'apollo',
    require('./universal-paid-approval-handler').OPERATION,
    payload,
    summary,
  );

  missions.update(mission.missionId, {
    status: 'AWAITING_APOLLO_APPROVAL',
    completionState: 'AWAITING_APOLLO_APPROVAL',
    approvalId: approval.id,
    approvalValid: false,
    sheetName: inspection.sheetName,
    rowsRemaining: count,
  });

  return response(
    `${format(missions.get(mission.missionId))}\n\n${paidTools.prompt(approval)}`,
    {
      paidToolApproval: {
        id: approval.id,
        tool: approval.tool,
        operation: approval.operation,
        expiresAt: approval.expiresAt,
      },
      universalEnrichmentMission: missions.publicSummary(missions.get(mission.missionId)),
      targetRowSelection: selection,
    },
  );
}

// Policy continuity preflight. A mission records the selection policy it was
// approved and started under. Resuming under a different policy would silently
// change whether a usable phone is a hard qualification, so it is refused
// without touching the sheet, the budget or the mission's saved state.
function policyConflictResponse(mission) {
  const phoneFirstPolicy = require('./universal-phone-first-policy');
  const resolved = phoneFirstPolicy.resolveMode(mission.request || {}, {});
  const conflict = phoneFirstPolicy.policyConflict(mission, resolved);
  if (!conflict.conflict) return null;
  return response(
    [
      `Resume refused: the selection policy changed for mission ${mission.missionId}.`,
      '',
      `Approved policy: ${conflict.savedMode}${conflict.savedIndiaRequired ? ' (India phone required)' : ''}`,
      `Resolved policy: ${conflict.currentMode}${conflict.currentIndiaRequired ? ' (India phone required)' : ''}`,
      '',
      'Nothing was re-run and no cell was written; the saved mission is unchanged and still resumable under its own policy.',
      `Start a new enrichment run with the "${conflict.currentMode}" policy, or resume this mission without changing its policy.`,
    ].join('\n'),
    {
      error: conflict.code,
      errorCode: conflict.code,
      errorSubsystem: 'POLICY',
      errorType: 'POLICY',
      errorStage: 'resume-policy-preflight',
      universalEnrichmentMission: missions.publicSummary(mission),
      policyConflict: conflict,
    },
  );
}

async function resume() {
  const mission = missions.latestResumable();
  if (!mission) return response('No resumable universal spreadsheet-enrichment mission was found.');

  const policyRefusal = policyConflictResponse(mission);
  if (policyRefusal) return policyRefusal;

  if (mission.nextEligibleAt && Date.now() < Date.parse(mission.nextEligibleAt)) {
    return response(
      `Enrichment safely paused\n\nReason: Apollo provider cooldown\nCompleted: ${mission.rowsProcessed || 0} / ${mission.totalEligibleRows || '?'}\nLast processed row: ${mission.lastProcessedRow ?? 'unknown'}\nNext row: ${mission.nextRow ?? 'unknown'}\nNext safe retry: ${new Date(mission.nextEligibleAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST\nNo completed work will be repeated.`,
      { universalEnrichmentMission: missions.publicSummary(mission) },
    );
  }

  const inspection = await inspectMission(mission);
  const frontier = recoverForwardFrontier(mission, inspection);
  missions.setRecoveredFrontier(mission.missionId, frontier);

  const allRows = eligibleRows(inspection);
  const targetRows = allRows.filter((rowNumber) => (
    Number.isInteger(Number(frontier.nextRow))
      ? rowNumber >= Number(frontier.nextRow)
      : true
  ));
  const targetSelection = targetRows.length
    ? rowSelection.fromRange(targetRows[0], targetRows.at(-1), targetRows.length)
    : null;

  if (!targetRows.length) {
    const completed = missions.update(mission.missionId, {
      status: 'COMPLETE',
      completionState: 'COMPLETE',
      rowsRemaining: 0,
      completedAt: new Date().toISOString(),
    });
    return response(
      `Forward enrichment is already at the end of the worksheet. Last processed row: ${completed.lastProcessedRow ?? frontier.lastProcessedRow ?? 'unknown'}. Use "retry unresolved enrichment" if you intentionally want to revisit earlier unresolved rows.`,
      { universalEnrichmentMission: missions.publicSummary(completed) },
    );
  }

  const saved = missions.get(mission.missionId);
  return requestApproval(
    saved,
    inspection,
    targetSelection,
    `Resume saved enrichment mission ${mission.missionId} in FORWARD-ONLY mode from row ${frontier.nextRow}. Rows before ${frontier.nextRow} will not be replayed. Historical unresolved rows require the separate "retry unresolved enrichment" command.`,
    targetRows.length,
  );
}

async function retryUnresolved() {
  const mission = missions.latestResumable() || missions.latest();
  if (!mission) return response('No universal spreadsheet-enrichment mission is available for unresolved-row retry.');

  const policyRefusal = policyConflictResponse(mission);
  if (policyRefusal) return policyRefusal;

  const inspection = await inspectMission(mission);
  const frontier = recoverForwardFrontier(mission, inspection);
  const allRows = eligibleRows(inspection);
  const historicalLimit = Number.isInteger(Number(frontier.lastProcessedRow))
    ? Number(frontier.lastProcessedRow)
    : (allRows.at(-1) || 0);
  const checkpoints = mission.rowCheckpoints || {};

  let targetRows = allRows.filter((rowNumber) => {
    if (rowNumber > historicalLimit) return false;
    const checkpoint = checkpoints[String(rowNumber)];
    return Boolean(checkpoint && checkpoint.state !== 'COMPLETE');
  });

  // Legacy missions may predate row checkpoints. In that case a deliberate
  // backfill may target earlier rows that still have blanks inside WriteScope.
  if (!targetRows.length && !Object.keys(checkpoints).length) {
    const columns = scopeColumnIndexes(mission);
    targetRows = allRows.filter((rowNumber) => {
      if (rowNumber > historicalLimit || !columns.length) return false;
      const row = inspection.rows?.[rowNumber - 1] || [];
      return columns.some((columnIndex) => !text(row[columnIndex]) || /^null$/i.test(text(row[columnIndex])));
    });
  }

  targetRows = [...new Set(targetRows)].sort((a, b) => a - b);

  if (!targetRows.length) {
    return response(
      'No historical unresolved rows were found inside the saved enrichment write scope. Forward progress was left unchanged.',
      { universalEnrichmentMission: missions.publicSummary(mission) },
    );
  }

  return requestApproval(
    mission,
    inspection,
    rowSelection.fromRows(targetRows),
    `Retry ${targetRows.length} historical unresolved enrichment row(s). This is an explicit BACKFILL pass; the normal forward cursor remains at row ${frontier.nextRow ?? 'unknown'} and will not be rewound.`,
    targetRows.length,
  );
}

async function handle(value) {
  if (isHealth(value)) return health();
  if (isStatus(value)) {
    const mission = missions.latestResumable() || missions.latest();
    return response(format(mission), { universalEnrichmentMission: missions.publicSummary(mission) });
  }
  if (isRetryUnresolved(value)) return retryUnresolved();
  if (isResume(value)) return resume();
  return null;
}

module.exports = {
  isResume,
  isRetryUnresolved,
  isStatus,
  isHealth,
  isControlRequest,
  handle,
  format,
  health,
  recoverForwardFrontier,
  retryUnresolved,
  resume,
};
