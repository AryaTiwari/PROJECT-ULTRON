'use strict';

const compiler = require('./apollo-lead-intent-compiler');
const paid = require('./paid-tool-approval');
const missionStore = require('./apollo-lead-mission-store');
const runner = require('./apollo-lead-mission-runner');
const companies = require('./apollo-company-discovery');
const people = require('./apollo-people-discovery');
const apollo = require('./apollo-enrichment');
const selector = require('./apollo-poc-selector');
const contact = require('./apollo-contactability-policy');
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
    `Apollo calls: ${status.apolloCalls}. Search variants tried: ${status.searchVariantsTried}. Sheet rows written: ${status.rowsWritten}. Remaining: ${status.remainingTarget == null ? 'unknown' : status.remainingTarget}.`,
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
      sheetId: info.target.sheetId ?? null,
      preflighted: true,
    },
  });
}

async function hydrateCompanyPocs(company, compiled, state) {
  const candidates = await people.forCompany(company, { location: compiled.geography, limit: 12 });
  state.peopleDiscovered += candidates.length;
  state.apolloCalls += 1;

  const ranked = [...candidates]
    .filter((person) => selector.acceptable(person, company))
    .sort(selector.compare(1))
    .slice(0, 3);

  const hydrated = [];
  for (const candidate of ranked) {
    try {
      const item = await apollo.resolveDecisionMaker(candidate, company.name, company.domain, {
        needEmail: true,
        needPhone: true,
      });
      state.apolloCalls++;
      state.paidCalls++;
      state.peopleVerified++;
      state.phoneAvailabilityChecked++;
      if (item.phone) state.phoneReveals++;
      if (item.email) state.emailReveals++;
      hydrated.push(item);
    } catch (error) {
      if (!['APOLLO_IDENTITY_MISMATCH', 'APOLLO_COMPANY_MISMATCH_AFTER_HYDRATION'].includes(error.code)) throw error;
    }
  }
  return selector.selectPocs(hydrated, company, compiled.requestedPocs);
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
  let selected = discovered.organizations.slice(0, compiled.targetCount);
  let replacements = 0;

  missionStore.update(mission.missionId, {
    currentPhase: compiled.enrichmentRequested ? 'qualifying_contacts' : (compiled.sheet?.requested ? 'writing' : 'finalizing'),
    companyCandidatesFound: discovered.candidatesFound,
    companiesQualified: discovered.qualified,
    companiesRejected: discovered.rejected,
    companiesSelected: selected.length,
    searchVariantsTried: discovered.searchVariantsTried || 0,
    searchDiagnostics: discovered.searchDiagnostics || [],
    apolloCalls: state.apolloCalls,
    paidCalls: state.paidCalls,
    remainingTarget: Math.max(0, compiled.targetCount - selected.length),
  });

  if (compiled.enrichmentRequested) {
    selected = [];
    const foreignFallback = [];
    for (const company of discovered.organizations) {
      if (selected.length >= compiled.targetCount) break;
      const pocs = await hydrateCompanyPocs(company, compiled, state);
      const row = { ...company, ...pocs };
      const qualities = pocs.selected.map(contact.quality);
      if (qualities.some((quality) => quality >= 3)) selected.push(row);
      else if (qualities.some((quality) => quality >= 1)) foreignFallback.push(row);
      else replacements++;
      missionStore.update(mission.missionId, {
        currentPhase: 'qualifying_contacts',
        companiesSelected: selected.length,
        companiesReplacedForContactability: replacements,
        peopleDiscovered: state.peopleDiscovered,
        peopleVerified: state.peopleVerified,
        phoneAvailabilityChecked: state.phoneAvailabilityChecked,
        phoneReveals: state.phoneReveals,
        emailReveals: state.emailReveals,
        apolloCalls: state.apolloCalls,
        paidCalls: state.paidCalls,
      });
    }
    for (const row of foreignFallback) {
      if (selected.length >= compiled.targetCount) break;
      selected.push(row);
    }
  }

  missionStore.update(mission.missionId, {
    currentPhase: compiled.sheet?.requested ? 'writing' : 'finalizing',
    companiesSelected: selected.length,
  });

  const projection = await projector.project(compiled, selected, {
    includePeople: compiled.enrichmentRequested,
  });

  if (compiled.sheet?.requested && selected.length > 0 && projection.rowsWritten === 0 && projection.skippedDuplicates === 0) {
    const error = new Error('Apollo selected companies, but the requested Sheet received no rows and no duplicates explained the zero-write result.');
    error.code = 'APOLLO_LEAD_PROJECTION_ZERO_WRITE';
    error.stage = 'apollo-lead-sheet-projection';
    throw error;
  }

  const p1 = selected.filter((row) => row.poc1).length;
  const p2 = selected.filter((row) => row.poc2).length;
  const india = selected
    .flatMap((row) => [row.poc1, row.poc2])
    .filter((person) => person && contact.indianPhone(person.phone, person.country || person.location)).length;
  const foreign = selected
    .flatMap((row) => [row.poc1, row.poc2])
    .filter((person) => person && contact.validPhone(person.phone) && !contact.indianPhone(person.phone, person.country || person.location)).length;

  const final = missionStore.update(mission.missionId, {
    currentPhase: 'completed',
    completionReason: selected.length >= compiled.targetCount ? 'target_reached' : 'bounded_reserve_exhausted',
    companyCandidatesFound: discovered.candidatesFound,
    companiesQualified: discovered.qualified,
    companiesRejected: discovered.rejected,
    companiesSelected: selected.length,
    searchVariantsTried: discovered.searchVariantsTried || 0,
    searchDiagnostics: discovered.searchDiagnostics || [],
    peopleDiscovered: state.peopleDiscovered,
    peopleVerified: state.peopleVerified,
    phoneAvailabilityChecked: state.phoneAvailabilityChecked,
    phoneReveals: state.phoneReveals,
    emailReveals: state.emailReveals,
    POC1Selected: p1,
    POC2Selected: p2,
    companiesReplacedForContactability: replacements,
    apolloCalls: state.apolloCalls,
    paidCalls: state.paidCalls,
    rowsWritten: projection.rowsWritten,
    skippedDuplicates: projection.skippedDuplicates || 0,
    remainingTarget: Math.max(0, compiled.targetCount - selected.length),
    safetyState: 'complete',
    completedAt: new Date().toISOString(),
  });

  const discoveryAudit = `Apollo organization search pages: ${discovered.apolloCalls}; search variants tried: ${discovered.searchVariantsTried || 0}; raw unique candidates: ${discovered.candidatesFound}; qualified: ${discovered.qualified}.`;
  const projectionAudit = compiled.sheet?.requested
    ? `Sheet rows written: ${projection.rowsWritten}; duplicates skipped: ${projection.skippedDuplicates || 0}; live reread verified: ${projection.liveVerified ? 'yes' : 'no'}.`
    : 'No Sheet destination requested.';

  const body = compiled.enrichmentRequested
    ? `Source: Apollo\nCompanies selected: ${selected.length}\nCompanies written: ${projection.rowsWritten}\nPOC-1 filled: ${p1}\nPOC-2 filled: ${p2}\nCompanies replaced due to poor contactability: ${replacements}\nIndian-number POCs: ${india}\nForeign-number fallback POCs: ${foreign}\nApollo contact reveals: ${state.phoneReveals}\n${discoveryAudit}\n${projectionAudit}`
    : `Source: Apollo\nCompanies discovered: ${selected.length}\nCompanies written: ${projection.rowsWritten}\nPOC enrichment: not requested\nApollo contact reveals: 0\n${discoveryAudit}\n${projectionAudit}\n${formatCompanyLines(selected)}`;

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
    return response(false, `Apollo lead discovery did not start: ${error.message}`, {
      error: error.code || 'APOLLO_LEAD_PREFLIGHT_FAILED',
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
  hydrateCompanyPocs,
  executeApproved,
  handle,
  contract,
};
