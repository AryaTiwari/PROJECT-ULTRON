'use strict';

// First-class owner for universal spreadsheet contact enrichment.
// Pre-approval inspection is deterministic/schema-only. Approved execution stays
// deterministic-first; Big Pickle may be consulted only for bounded ambiguity.

const sheets = require('./google-sheets-operator');
const paidTools = require('./paid-tool-approval');
const targetResolver = require('./universal-sheet-target-resolver');
const inspector = require('./universal-sheet-inspector');
const approvalHandler = require('./universal-paid-approval-handler');
const typedErrors = require('./spreadsheet-enrichment-errors');

approvalHandler.install();

function text(value) { return String(value == null ? '' : value).trim(); }

function parseSheetName(message) {
  const value = String(message || '');
  // "worksheet" is a first-class synonym for "sheet"/"tab". This matters for
  // prompts such as: Target only the `Arya 2` worksheet.
  const linePatterns = [
    // Common production phrasing: "Enrich ... on the \"Arya 2\" worksheet".
    /\bon\s+(?:only\s+)?(?:the\s+)?[`"'“”]([^\n`"'“”]{1,120})[`"'“”]\s+(?:tab|sheet|worksheet)\b/i,
    /\bon\s+(?:only\s+)?(?:the\s+)?([^\n,.;]{1,120}?)\s+(?:tab|sheet|worksheet)\b/i,
    /(?:^|\n)\s*(?:target|use)\s+(?:only\s+)?(?:the\s+)?[`"'“”]([^\n`"'“”]{1,120})[`"'“”]\s+(?:tab|sheet|worksheet)\b/im,
    /(?:^|\n)\s*(?:target|use)\s+(?:only\s+)?(?:the\s+)?([^\n,.;]{1,120}?)\s+(?:tab|sheet|worksheet)\b/im,
    /(?:^|\n)\s*(?:target|use|sheet|tab|worksheet)\s+(?:only\s+)?(?:tab|sheet|worksheet)?\s*[:=\-]\s*[`"'“”]?([^\n`"'“”]{1,120})/im,
    /(?:^|\n)\s*target\s+(?:only\s+)?(?:the\s+)?(?:tab|sheet|worksheet)\s+["'`“”]?([^\n"'`“”]{1,120})/im,
    /\b(?:target|use)\s+(?:only\s+)?(?:the\s+)?(?:tab|sheet|worksheet)\s+(?:named\s+)?["'`“”]?([^\n,.;"'`“”]{1,100})/i,
  ];
  for (const pattern of linePatterns) {
    const match = value.match(pattern);
    if (!match) continue;
    const candidate = text(match[1])
      .replace(/^[`"'“”]+|[`"'“”]+$/g, '')
      .replace(/[.]+$/, '')
      .trim();
    if (candidate && !/^(?:only|the|tab|sheet|worksheet)$/i.test(candidate)) return candidate;
  }
  return '';
}

function parseExpectedPersonGroups(message) {
  const value = String(message || '');
  const found = [];

  for (const match of value.matchAll(/\b(?:poc|contact|person)(?:\s*[-#:]?\s*)(\d{1,2})\b/gi)) {
    found.push(Number(match[1]));
  }
  for (const match of value.matchAll(/\b(\d{1,2})\s+(?:pocs?|person\s+groups?|contact\s+groups?)\b/gi)) {
    found.push(Number(match[1]));
  }

  const wordOrdinals = {
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
    sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  };
  for (const match of value.matchAll(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+(?:poc|contact|person)\b/gi)) {
    found.push(wordOrdinals[String(match[1]).toLowerCase()] || 0);
  }

  const env = Number(process.env.ULTRON_M3_UNIVERSAL_EXPECTED_PERSON_GROUPS || 0);
  if (Number.isFinite(env) && env > 0) found.push(env);

  const valid = found.filter((value) => Number.isInteger(value) && value >= 1 && value <= 20);
  return valid.length ? Math.max(...valid) : 0;
}

function parseContactPhaseOrdinal(message) {
  const value = String(message || '');

  // Diagnostic phase selection must be explicit. Do not infer "POC-2 only"
  // from production sentences such as "POC-2 discovery is necessary only
  // where F is blank".
  const definitions = [
    {
      ordinal: 1,
      patterns: [
        /\b(?:poc\s*[- ]?1|1st\s+poc|first\s+poc)\s+only\b/i,
        /\bonly\s+(?:the\s+)?(?:poc\s*[- ]?1|1st\s+poc|first\s+poc)\b/i,
        /\bjust\s+(?:the\s+)?(?:poc\s*[- ]?1|1st\s+poc|first\s+poc)\b/i,
      ],
    },
    {
      ordinal: 2,
      patterns: [
        /\b(?:poc\s*[- ]?2|2nd\s+poc|second\s+poc)\s+only\b/i,
        /\bonly\s+(?:the\s+)?(?:poc\s*[- ]?2|2nd\s+poc|second\s+poc)\b/i,
        /\bjust\s+(?:the\s+)?(?:poc\s*[- ]?2|2nd\s+poc|second\s+poc)\b/i,
      ],
    },
    {
      ordinal: 3,
      patterns: [
        /\b(?:poc\s*[- ]?3|3rd\s+poc|third\s+poc)\s+only\b/i,
        /\bonly\s+(?:the\s+)?(?:poc\s*[- ]?3|3rd\s+poc|third\s+poc)\b/i,
        /\bjust\s+(?:the\s+)?(?:poc\s*[- ]?3|3rd\s+poc|third\s+poc)\b/i,
      ],
    },
  ];

  for (const definition of definitions) {
    if (definition.patterns.some((pattern) => pattern.test(value))) return definition.ordinal;
  }
  return null;
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
    model: 'mark3-universal-hybrid-enrichment',
    provider: 'deterministic+apollo+google-sheets+bounded-direct-env-ai',
    taskType: 'universal-sheet-enrichment',
    mode: 'operator',
    toolRounds: 0,
    ...extra,
  };
}

function typedFailure(error, context = {}) {
  const typed = typedErrors.normalize(error, context);
  return {
    typed,
    diagnostic: typedErrors.format(typed),
    fields: {
      error: typed.code,
      errorCode: typed.code,
      errorSubsystem: typed.subsystem,
      errorType: typed.type,
      errorStage: typed.stage,
      errorHint: typed.hint,
      errorMessage: typed.message,
      retryAttempts: typed.retryAttempts,
      attemptedRange: typed.attemptedRange || null,
      endpoint: typed.endpoint || null,
      providerStatus: typed.providerStatus ?? typed.status ?? null,
    },
  };
}

function schemaReadable(summary = {}) {
  const people = Array.isArray(summary.personGroups) ? summary.personGroups.length : 0;
  const companies = Array.isArray(summary.companyGroups) ? summary.companyGroups.length : 0;
  const confidence = Number(summary.confidence || 0);
  return confidence >= 0.48 && (people > 0 || companies > 0);
}

function approvalSummary(inspection) {
  const summary = inspection?.schema || {};
  const analysis = inspection?.analysis?.stats || {};
  const people = summary.personGroups?.length || 0;
  const companies = summary.companyGroups?.length || 0;
  const header = summary.headerRowNumber || '?';
  return [
    `ULTRON deterministically inspected worksheet "${inspection?.sheetName || '?'}" before Apollo approval.`,
    rowLimitNotice(inspection?.rowLimitApplied),
    `It detected header row ${header}, ${people} person/contact group${people === 1 ? '' : 's'} and ${companies} company group${companies === 1 ? '' : 's'} without assuming a fixed POC count or fixed column letters.`,
    (summary.continuityRecoveries || []).length
      ? `Schema continuity recovery reconstructed ${(summary.continuityRecoveries || []).length} explicitly expected missing contact group${(summary.continuityRecoveries || []).length === 1 ? '' : 's'} in blank trailing columns. ${(summary.headerRepairs || []).length} missing header cell${(summary.headerRepairs || []).length === 1 ? '' : 's'} will be restored only after approval and only if those cells are still blank.`
      : 'Schema continuity recovery was not needed.',
    `The planned pass contains ${analysis.openPersonSlots || 0} open and ${analysis.partialPersonSlots || 0} partial person/contact slots within the currently eligible row range.`,
    'Pre-approval inspection uses worksheet values only: no Apollo, LinkedIn profile fetch, Big Pickle or other AI/model call occurs.',
    'During approved execution, worksheet targeting, schema inference, ownership, anchor handling, Apollo discovery/hydration, verification and spreadsheet writes remain deterministic.',
    'Priority contract: ordinary production enrichment is coordinated across POC-1, POC-2 and POC-3 in one sheet run with shared discovery/cache state. POC-1 exact-anchor contact completion runs first within each row; existing POC-2/POC-3 identities remain contact-completion jobs; blank secondary POC identities may be discovered from the verified hiring-company context. Explicit requests such as POC-1 only, POC-2 only or POC-3 only switch to isolated deterministic diagnostic phases. Exact person evidence may fill missing phone/email even when row employer context is stale; employer verification remains mandatory whenever ULTRON selects a new person.',
    'After deterministic employer resolution, POC-2 discovery runs a results-first waterfall: targeted Apollo -> bounded broad Apollo -> brand/domain variants -> authenticated read-only LinkedIn company/people discovery when Apollo is sparse. Deterministic selection tries the preferred Founder/Director/Owner > HR/Talent/Recruiting Head/Manager > Recruiter ladder first, then a pragmatic same-company HR/talent/staffing/placement/people/leadership fallback. Every final person still requires exact identity and employer verification before a write.',
    'For a FINAL verified POC whose phone is still blank, ULTRON uses Apollo native phone reveal with webhook settlement as the production default. It never buys phone enrichment for discovery-only candidates and never enables personal-email reveal. The custom poll_only phone waterfall is experimental/legacy-only; already-paid legacy request IDs remain resumable by exact sheet row/cell, while new phone work uses the native reveal path. Email waterfall remains bounded to final verified POCs.',
    'In coordinated production mode, bounded AI receives only still-open secondary POC slots after deterministic/manual verification and only supplied employer-verified candidates. Gemini is preferred for unresolved row/company context, Groq for candidate assignment, and NVIDIA for optional independent review; each logical role can fall through the other direct providers on failure. Maximum 3 direct env-backed AI attempts apply to the entire run, not per row. Explicit POC-only diagnostic runs stay deterministic-only. OmniRoute is not used by the direct batch path.',
    'The AI may choose only supplied Apollo candidate keys and employer wording supported by the row evidence. It cannot invent candidates, choose worksheets/columns, bypass Apollo identity/employer verification or write cells directly.',
    'Completion rule: partial progress is never enough. Any mandatory unresolved POC-2 row continues through the next safe strategy even when sibling rows were solved. When three POCs were explicitly requested, unresolved POC-3 also receives deep deterministic recheck and bounded AI rescue before the run closes, but it never forces an unsafe or fabricated contact. After manual + direct AI + exact-row last resort, ULTRON re-reads the live sheet and may close only with exact unresolved rows/reasons.',
    'Apollo will be used only after approval for exact identity/contact discovery and hydration, and existing populated identities/contacts are preserved unless an exact verified same-person repair is safe.',
  ].join(' ');
}

function recoverMentionedSheetName(meta = {}, sourceText = '') {
  const haystack = String(sourceText || '').toLocaleLowerCase();
  if (!haystack) return '';
  const tabs = targetResolver.tabsFromMetadata(meta);
  const matches = tabs.filter((tab) => {
    const name = text(tab?.name);
    if (!name) return false;
    const folded = name.toLocaleLowerCase();
    return haystack.includes(`"${folded}"`)
      || haystack.includes(`'${folded}'`)
      || haystack.includes(`${folded} worksheet`)
      || haystack.includes(`${folded} sheet`)
      || haystack.includes(`${folded} tab`);
  });
  return matches.length === 1 ? matches[0].name : '';
}

function metadataFallbackTarget(sheetUrl, requestedSheetName) {
  const requestedGid = targetResolver.parseGid(sheetUrl);
  const sheetId = Number.isFinite(Number(requestedGid)) ? Number(requestedGid) : null;
  return {
    targeted: true,
    targetSource: 'explicit-name-metadata-fallback',
    requestedName: requestedSheetName,
    requestedGid,
    ignoredViewGid: false,
    metadataFallback: true,
    target: { name: requestedSheetName, sheetId },
  };
}

async function resolveRequestedTarget(sheetUrl, requestedSheetName = '', options = {}) {
  const spreadsheetId = sheets.spreadsheetId(sheetUrl);
  let meta;
  try {
    meta = await sheets.metadata(spreadsheetId);
  } catch (error) {
    // Exact explicit tab names are sufficient for safe A1-range reads. Do not let
    // workbook metadata become a single point of failure when the target is named.
    if (!requestedSheetName || !options.explicitNameAuthoritative) {
      if (!error.code) error.code = 'UNIVERSAL_SHEET_METADATA_FAILED';
      error.stage = error.stage || 'sheet-metadata-read';
      throw error;
    }
    const resolution = metadataFallbackTarget(sheetUrl, requestedSheetName);
    return {
      spreadsheetId,
      spreadsheetTitle: '',
      resolution,
      sheetName: requestedSheetName,
      sheetId: resolution.target.sheetId,
      targetSource: resolution.targetSource,
    };
  }
  const recoveredSheetName = requestedSheetName || recoverMentionedSheetName(meta, options.sourceText || '');
  const resolution = targetResolver.resolveTabs(meta, sheetUrl, {
    sheetName: recoveredSheetName || undefined,
    explicitNameAuthoritative: Boolean(options.explicitNameAuthoritative || recoveredSheetName),
  });
  if (!resolution.target?.name) {
    const error = new Error('An exact worksheet name or worksheet gid is required before universal enrichment can inspect or edit a multi-tab workbook.');
    error.code = 'UNIVERSAL_SHEET_TARGET_REQUIRED';
    error.stage = 'sheet-target-resolution';
    error.availableTabs = (resolution.tabs || []).map((tab) => tab.name).filter(Boolean);
    throw error;
  }
  return {
    spreadsheetId,
    spreadsheetTitle: meta?.properties?.title || '',
    resolution,
    sheetName: resolution.target.name,
    sheetId: resolution.target?.sheetId ?? null,
    targetSource: resolution.targetSource,
  };
}

async function inspect(sheetUrl, sheetName, rowLimit, options = {}) {
  const target = await resolveRequestedTarget(sheetUrl, sheetName, {
    ...options,
    sourceText: options.sourceText || '',
  });
  const inspection = await inspector.inspectExact({
    spreadsheetId: target.spreadsheetId,
    spreadsheetTitle: target.spreadsheetTitle,
    sheetName: target.sheetName,
    sheetId: target.sheetId,
    rowLimit,
    schemaOptions: options.schema || {},
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
      metadataFallback: Boolean(target.resolution.metadataFallback),
    },
  };
}

async function handle(message, context = {}) {
  const original = String(context.originalMessage || message || '');
  const sheetUrl = sheets.extractSheetUrl(original) || sheets.extractSheetUrl(message);
  if (!sheetUrl) {
    const failure = typedFailure(Object.assign(new Error('No full Google Sheets URL could be resolved.'), {
      code: 'UNIVERSAL_SPREADSHEET_URL_REQUIRED',
      subsystem: 'TARGETING',
      errorType: 'CONFIG',
      stage: 'spreadsheet-source-resolution',
    }));
    return response(false,
      `Universal spreadsheet enrichment stopped safely: ${failure.diagnostic}. ${failure.typed.hint} Nothing was edited and Apollo was not called.`,
      { ...failure.fields, diagnostic: failure.diagnostic, apolloCalled: false });
  }

  const requestedSheetName = parseSheetName(original);
  const expectedPersonGroups = parseExpectedPersonGroups(original);
  const contactPhaseOrdinal = parseContactPhaseOrdinal(original);
  const explicitNameAuthoritative = Boolean(requestedSheetName);
  const rowLimit = configuredRowLimit();
  let inspection;
  try {
    inspection = await inspect(sheetUrl, requestedSheetName, rowLimit, {
      explicitNameAuthoritative,
      sourceText: original,
      schema: expectedPersonGroups ? { expectedPersonGroups } : {},
    });
  } catch (error) {
    const failure = typedFailure(error, { stage: error?.stage || 'preapproval-inspection' });
    return response(false,
      `Universal spreadsheet inspection stopped safely: ${failure.diagnostic}. ${failure.typed.hint} Nothing was edited and Apollo was not called.`,
      {
        ...failure.fields,
        diagnostic: failure.diagnostic,
        apolloCalled: false,
        spreadsheetUrl: sheetUrl,
        sheetName: requestedSheetName || null,
        requestedGid: targetResolver.parseGid(sheetUrl),
      });
  }

  const exactSheetName = inspection.sheetName || inspection.requestedTarget?.sheetName || requestedSheetName || '';
  const summary = inspection.schema || {};
  if (!schemaReadable(summary)) {
    const failure = typedFailure(Object.assign(new Error(`Schema confidence ${Number(summary.confidence || 0).toFixed(2)} is below the safe enrichment threshold.`), {
      code: 'UNIVERSAL_SCHEMA_CONFIDENCE_TOO_LOW',
      subsystem: 'SCHEMA',
      errorType: 'SCHEMA',
      stage: 'schema-confidence-gate',
    }));
    return response(false,
      `Universal spreadsheet enrichment stopped safely: ${failure.diagnostic}. ${failure.typed.hint} Nothing was edited and Apollo was not called.`,
      { ...failure.fields, diagnostic: failure.diagnostic, apolloCalled: false, spreadsheetUrl: sheetUrl, sheetName: exactSheetName || null, schema: summary });
  }

  const request = {
    url: sheetUrl,
    provider: 'google',
    universal: true,
    sheetName: exactSheetName,
    sheetId: inspection.requestedTarget?.sheetId ?? null,
    targetSource: inspection.requestedTarget?.source || 'none',
    explicitNameAuthoritative,
    rowLimit: rowLimit || null,
    expectedPersonGroups: expectedPersonGroups || null,
    contactPhaseOrdinal: contactPhaseOrdinal || null,
    schemaFingerprint: summary.fingerprint || null,
    requestedAt: new Date().toISOString(),
  };

  const approval = paidTools.request(
    'apollo',
    approvalHandler.OPERATION,
    request,
    approvalSummary(inspection),
  );

  return response(true, paidTools.prompt(approval), {
    model: 'apollo-approval-gate',
    provider: 'local-approval-gate',
    taskType: 'paid-tool-approval',
    paidToolApproval: { id: approval.id, tool: approval.tool, operation: approval.operation, expiresAt: approval.expiresAt },
    universalEnrichmentRequest: request,
    universalSchema: summary,
    universalAnalysis: inspection.analysis?.stats || null,
    spreadsheetUrl: sheetUrl,
    sheetName: exactSheetName || null,
    requestedTarget: inspection.requestedTarget || null,
    rowLimitApplied: rowLimit || null,
    validationMode: Boolean(rowLimit),
    inspectionMode: inspection.inspectionMode,
    deterministicPrimary: true,
    fallbackModelAvailable: true,
    boundedAiBatchAvailable: true,
    boundedAiBatchMaxCalls: Math.max(1, Math.min(3, Number(process.env.ULTRON_M3_UNIVERSAL_AI_BATCH_MAX_CALLS || 3))),
    expectedPersonGroups: expectedPersonGroups || null,
    contactPhaseOrdinal: contactPhaseOrdinal || null,
    schemaContinuityRecoveries: summary.continuityRecoveries || [],
    plannedHeaderRepairs: summary.headerRepairs || [],
    modelCalls: 0,
  });
}

module.exports = {
  handle,
  inspect,
  resolveRequestedTarget,
  parseSheetName,
  parseExpectedPersonGroups,
  parseContactPhaseOrdinal,
  configuredRowLimit,
  rowLimitNotice,
  schemaReadable,
  approvalSummary,
  metadataFallbackTarget,
  recoverMentionedSheetName,
  typedFailure,
  installApprovalHandler: approvalHandler.install,
};
