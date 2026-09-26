'use strict';

const compiler = require('./apollo-lead-intent-compiler');
const paid = require('./paid-tool-approval');
const missionStore = require('./apollo-lead-mission-store');
const runner = require('./apollo-lead-mission-runner');
const companies = require('./apollo-company-discovery');
const people = require('./apollo-people-discovery');
const projector = require('./apollo-lead-sheet-projector');
const contract = require('./apollo-lead-contract');

const OPERATION = 'apollo-lead-intelligence';

function text(value) { return String(value == null ? '' : value).trim(); }

function response(ok, body, extra = {}) {
  const annotated = contract.annotate(body);
  return {
    ok,
    response: annotated,
    text: annotated,
    model: 'apollo-lead-intelligence',
    provider: 'apollo',
    taskType: 'apollo-lead-intelligence',
    mode: 'operator',
    toolRounds: 0,
    apolloLeadContractVersion: contract.VERSION,
    runtimeBuildId: contract.runtimeBuild.id,
    runtimeRevision: contract.runtimeBuild.revision,
    runtimeSourceFingerprint: contract.runtimeBuild.fingerprint,
    ...extra,
  };
}

function summary(mission) {
  const filters = mission.compiledFilters || {};
  const range = filters.employeeRange || {};
  const size = range.explicit || range.hard
    ? `size ${range.min == null ? 1 : range.min}-${range.max == null ? 'any' : range.max}`
    : `SMB preferred ${range.preferredMin || 20}-${range.preferredMax || 300} employees; discovery focus ${range.min || 10}-${range.max || 500}, relax if needed`;
  return `Mission ${mission.missionId}: ${mission.missionType}; target ${mission.targetCount}; geography ${filters.geography || 'any'}; ${size}; contact enrichment ${filters.enrichmentRequested ? 'requested' : 'not requested'}.`;
}

function progressBody(status) {
  if (!status) return 'No Apollo lead mission exists yet.';
  const lines = [
    `Apollo lead mission ${status.missionId}: ${status.phase}.`,
    `Target: ${status.targetCount}. Raw unique candidates: ${status.companyCandidatesFound}. Qualified companies: ${status.companiesQualified}. Selected: ${status.companiesSelected}.`,
    `Organization searches: ${status.organizationSearchCalls}. People searches: ${status.peopleSearchCalls}. Contact reveals: ${status.contactRevealCalls}. Cache hits: ${status.cacheHits}.`,
    `Search variants tried: ${status.searchVariantsTried}. Sheet rows written: ${status.rowsWritten}. Duplicates skipped: ${status.companiesAlreadyExisting}. Remaining: ${status.remainingTarget == null ? 'unknown' : status.remainingTarget}.`,
  ];
  if (status.sheetName) lines.push(`Worksheet: ${status.sheetName}.`);
  if (status.completionReason) lines.push(`Completion: ${status.completionReason}.`);
  if (status.lastError) lines.push(`Error: ${status.lastError.code}: ${status.lastError.message}`);
  return lines.join('\n');
}

function formatCompanyLines(rows) {
  return rows.slice(0, 30).map((row, index) => `${index + 1}. ${row.name} — ${row.companyLink}`).join('\n');
}

function formatPeopleLines(rows) {
  return rows.slice(0, 30).map((row, index) => `${index + 1}. ${row.name} — ${row.title || 'role unavailable'} — ${row.linkedinUrl || 'Apollo profile'}`).join('\n');
}

function missionIdFromProgressMessage(message) {
  return text(message).match(/\b(apollo-[a-z0-9-]+)\b/i)?.[1] || '';
}

async function preflightDestination(compiled) {
  if (!compiled.sheet?.requested) return compiled;

  if (!compiled.sheet.url) {
    const error = new Error('The requested Google Sheet destination could not be resolved from the message or attachment metadata. Apollo was not called.');
    error.code = 'APOLLO_LEAD_SHEET_SOURCE_UNRESOLVED';
    error.stage = 'apollo-lead-sheet-preflight';
    throw error;
  }

  const info = await projector.inspect(compiled);
  const columns = projector.schemaColumns(info);
  if (!Number.isInteger(columns.companyName)) {
    const error = new Error('The requested worksheet has no recognized company-name heading. Apollo was not called.');
    error.code = 'APOLLO_LEAD_COMPANY_COLUMN_REQUIRED';
    error.stage = 'apollo-lead-sheet-preflight';
    throw error;
  }
  if (!Number.isInteger(columns.companyLink) && !Number.isInteger(columns.website)) {
    const error = new Error('The requested worksheet has no recognized company-link or website heading. Apollo was not called.');
    error.code = 'APOLLO_LEAD_COMPANY_LINK_COLUMN_REQUIRED';
    error.stage = 'apollo-lead-sheet-preflight';
    throw error;
  }

  if (compiled.sheet?.alias) {
    compiler.sheetAliases.bind(compiled.sheet.alias, compiled.sheet.url, {
      sheetName: info.target.name,
      spreadsheetId: info.id,
      source: compiled.sheet.attachmentResolved
        ? 'verified-attachment'
        : compiled.sheet.aliasResolved
          ? 'verified-alias'
          : 'verified-explicit-url',
    });
  }

  return Object.freeze({
    ...compiled,
    sheet: {
      ...compiled.sheet,
      url: compiled.sheet.url,
      sheetName: info.target.name,
      spreadsheetId: info.id,
      sheetId: info.target.sheetId ?? null,
      exactTitle: info.target.name,
      preflighted: true,
    },
  });
}

async function executeApproved(compiled, missionId) {
  const mission = missionStore.update(missionId, {
    currentPhase: 'discovering',
    safetyState: 'approved',
    sheetName: compiled.sheet?.sheetName || null,
    sheetUrl: compiled.sheet?.url || null,
  }) || missionStore.create(compiled);

  const state = {
    apolloCalls: 0,
    paidCalls: 0,
    peopleDiscovered: 0,
    peopleVerified: 0,
    phoneAvailabilityChecked: 0,
    phoneReveals: 0,
    emailReveals: 0,
  };

  if (compiled.missionType === 'apollo_people_discovery') {
    const found = await people.discoverPeople(compiled);
    const rows = found.people;
    missionStore.update(mission.missionId, {
      currentPhase: compiled.sheet?.requested ? 'writing' : 'finalizing',
      peopleDiscovered: found.candidatesFound,
      peopleVerified: rows.length,
      companiesSelected: rows.length,
      apolloCalls: found.apolloCalls,
      paidCalls: found.paidCalls,
    });
    const projection = await projector.project(
      compiled,
      rows.map((person) => ({
        name: person.organizationName || person.organization_name || 'Apollo people result',
        companyLink: person.organizationDomain ? 'https://' + person.organizationDomain : '',
        poc1: person,
      })),
      { includePeople: true },
    );
    const final = missionStore.update(mission.missionId, {
      currentPhase: 'completed',
      completionReason: rows.length >= compiled.targetCount ? 'target_reached' : 'source_exhausted',
      peopleDiscovered: found.candidatesFound,
      peopleVerified: rows.length,
      companiesSelected: rows.length,
      rowsWritten: projection.rowsWritten,
      apolloCalls: found.apolloCalls,
      paidCalls: found.paidCalls,
      remainingTarget: Math.max(0, compiled.targetCount - rows.length),
      safetyState: 'complete',
    });
    return response(true, `Source: Apollo\nPeople discovered: ${rows.length}\nRows written: ${projection.rowsWritten}\nApollo contact reveals: 0\n${formatPeopleLines(rows)}`, {
      mission: final,
      records: rows,
      projection,
    });
  }

  const discovered = await companies.discover(compiled, {
    onProgress(progress) {
      missionStore.update(mission.missionId, {
        currentPhase: 'discovering',
        companyCandidatesFound: progress.candidatesFound,
        companiesQualified: progress.qualified,
        searchVariantsTried: progress.searchVariantsTried,
        apolloCalls: progress.apolloCalls,
        paidCalls: progress.apolloCalls,
        remainingTarget: Math.max(0, compiled.targetCount - progress.qualified),
        currentSearchVariant: progress.variantId || null,
      });
    },
  });

  state.apolloCalls += discovered.apolloCalls;
  state.paidCalls += discovered.paidCalls;
  const selected = discovered.organizations.slice(0, compiled.targetCount);

  missionStore.update(mission.missionId, {
    currentPhase: compiled.sheet?.requested ? 'writing' : 'finalizing',
    companyCandidatesFound: discovered.candidatesFound,
    candidatePoolTarget: discovered.candidatePoolTarget,
    companiesQualified: discovered.qualified,
    companiesSelected: selected.length,
    candidateCompanies: discovered.organizations,
    searchVariantsTried: discovered.searchVariantsTried || 0,
    searchDiagnostics: discovered.searchDiagnostics || [],
    apolloCalls: state.apolloCalls,
    organizationSearchCalls: discovered.apolloCalls,
    contactRevealCalls: 0,
    paidCalls: state.paidCalls,
    remainingTarget: Math.max(0, compiled.targetCount - selected.length),
  });

  const projection = await projector.project(compiled, selected, {
    includePeople: false,
  });

  if (compiled.sheet?.requested && selected.length > 0 && projection.rowsWritten === 0 && projection.skippedDuplicates === 0) {
    const error = new Error('Apollo selected companies, but the requested Sheet received no rows and no duplicates explained the zero-write result.');
    error.code = 'APOLLO_LEAD_PROJECTION_ZERO_WRITE';
    error.stage = 'apollo-lead-sheet-projection';
    throw error;
  }

  const final = missionStore.update(mission.missionId, {
    currentPhase: 'completed',
    completionReason: selected.length >= compiled.targetCount ? 'target_reached' : 'candidate_universe_exhausted',
    companyCandidatesFound: discovered.candidatesFound,
    candidatePoolTarget: discovered.candidatePoolTarget,
    companiesQualified: discovered.qualified,
    companiesSelected: selected.length,
    qualifiedCompanies: selected,
    companiesWritten: projection.rowsWritten,
    companiesAlreadyExisting: projection.skippedDuplicates || 0,
    companyFieldsWritten: projection.companyFieldsWritten || projection.cellsWritten || 0,
    organizationSearchCalls: discovered.apolloCalls,
    peopleSearchCalls: 0,
    contactRevealCalls: 0,
    phoneReveals: 0,
    emailReveals: 0,
    searchVariants: discovered.searchDiagnostics || [],
    searchVariantsTried: discovered.searchVariantsTried || 0,
    searchDiagnostics: discovered.searchDiagnostics || [],
    apolloOrganizationIds: selected.map((row) => row.id).filter(Boolean),
    apolloCalls: state.apolloCalls,
    paidCalls: state.paidCalls,
    rowsWritten: projection.rowsWritten,
    skippedDuplicates: projection.skippedDuplicates || 0,
    remainingTarget: Math.max(0, compiled.targetCount - selected.length),
    safetyState: 'complete',
    completedAt: new Date().toISOString(),
  });

  const body = [
    'Source: Apollo',
    `Requested companies: ${compiled.targetCount}`,
    `Candidates inspected: ${discovered.candidatesFound}`,
    `Qualified unique companies: ${discovered.qualified}`,
    `Companies written: ${projection.rowsWritten}`,
    `Duplicates skipped: ${projection.skippedDuplicates || 0}`,
    `Organization search calls: ${discovered.apolloCalls}`,
    `Search variants: ${discovered.searchVariantsTried || 0}`,
    `Cache reuse: ${final.cacheHits || 0}`,
    `Company fields written: ${projection.companyFieldsWritten || projection.cellsWritten || 0}`,
    'People searches: 0',
    'Contact reveals: 0',
    projection.liveVerified ? 'Live Sheet reread verified: yes' : 'Live Sheet reread verified: no',
    formatCompanyLines(selected),
  ].filter(Boolean).join('\n');

  return response(true, body, {
    mission: final,
    records: selected,
    projection,
  });
}

async function handle(message, options = {}) {
  if (compiler.isApolloLeadControlRequest(message)) {
    if (/\b(?:doctor|diagnostic|benchmark\s+status)\b/i.test(message)) {
      const latest = runner.progress(missionIdFromProgressMessage(message));
      const aliases = compiler.sheetAliases.list();
      return response(true, [
        'Apollo Lead doctor',
        `Contract: ${contract.VERSION}`,
        `Runtime build: ${contract.runtimeBuild.id}`,
        `Progress route owner: apollo-lead-domain-controller`,
        `Known live Sheet aliases: ${aliases.length}`,
        latest ? `Latest mission: ${latest.missionId} · ${latest.phase}` : 'Latest mission: none',
      ].join('\n'), {
        mission: latest,
        sheetAliases: aliases,
        approvalRequired: false,
      });
    }
    const missionId = missionIdFromProgressMessage(message);
    const status = runner.progress(missionId);
    return response(true, progressBody(status), {
      mission: status,
      approvalRequired: false,
      backgroundMission: Boolean(status?.running),
    });
  }

  const initial = compiler.compile(message, options);
  if (initial.missionType === 'apollo_existing_sheet_enrichment') {
    return require('./universal-spreadsheet-domain-controller').handle(message, options);
  }

  let compiled;
  try {
    compiled = await preflightDestination(initial);
  } catch (error) {
    const code = error.code || 'APOLLO_LEAD_PREFLIGHT_FAILED';
    const repair = error.reauthorizeCommand
      ? ` Repair: ${error.reauthorizeCommand}`
      : '';
    const message = `Apollo lead discovery did not start: ${error.message}${repair}`;
    return response(false, message, {
      error: message,
      errorCode: code,
      authReason: error.authReason || null,
      googleOAuthError: error.googleOAuthError || null,
      reauthorizeCommand: error.reauthorizeCommand || null,
      errorStage: error.stage || 'apollo-lead-sheet-preflight',
      apolloCalled: false,
      approvalRequired: false,
    });
  }

  const mission = missionStore.create(compiled);
  const approval = paid.request(
    'apollo',
    OPERATION,
    { compiled, missionId: mission.missionId },
    summary(mission),
  );
  const updated = missionStore.update(mission.missionId, {
    currentPhase: 'waiting_approval',
    approvalId: approval.id,
    sheetName: compiled.sheet?.sheetName || null,
    sheetUrl: compiled.sheet?.url || null,
  });

  return response(true, paid.prompt(approval), {
    mission: updated || mission,
    paidToolApproval: approval,
    apolloCalled: false,
    approvalRequired: true,
  });
}

module.exports = {
  OPERATION,
  response,
  summary,
  progressBody,
  preflightDestination,
  executeApproved,
  handle,
  contract,
};
