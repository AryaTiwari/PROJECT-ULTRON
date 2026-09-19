'use strict';

// Bounded AI reasoning rescue for universal spreadsheet enrichment.
//
// Deterministic code still owns worksheet/schema/columns/write safety. Apollo still
// owns discovery, identity hydration and contacts. AI receives only row evidence
// plus supplied Apollo candidate keys and may:
//   pass 1: summarize/resolve row employer + hiring context from supplied evidence;
//   pass 2: assign supplied Apollo candidates to unresolved empty POC slots;
//   pass 3: optionally review weak/incomplete selections.
// Maximum logical model calls are capped for the WHOLE run, never per row.

const control = require('./command-control-plane');
const direct = require('./direct-provider-router');
const engine = require('./universal-enrichment-engine');
const base = require('./universal-sheet-enrichment-operator');
const planner = require('./universal-enrichment-planner');
const ranker = require('./universal-authority-ranker');
const apollo = require('./apollo-enrichment');
const sheets = require('./google-sheets-operator');

function text(value) { return String(value ?? '').trim(); }
function enabled() {
  return !/^(0|false|no|off)$/i.test(String(process.env.ULTRON_M3_UNIVERSAL_AI_BATCH_RESCUE ?? '1').trim());
}
function maxCalls(options = {}) {
  const raw = Number(options.maxAiCalls ?? process.env.ULTRON_M3_UNIVERSAL_AI_BATCH_MAX_CALLS ?? 3);
  return Number.isFinite(raw) ? Math.max(1, Math.min(3, Math.floor(raw))) : 3;
}
function candidateLimit(options = {}) {
  const raw = Number(options.aiCandidateLimit ?? process.env.ULTRON_M3_UNIVERSAL_AI_BATCH_CANDIDATES ?? 8);
  return Number.isFinite(raw) ? Math.max(6, Math.min(18, Math.floor(raw))) : 12;
}
function parseJson(value) {
  const raw = String(value || '').trim().replace(/^\`\`\`(?:json)?\s*/i, '').replace(/\s*\`\`\`$/i, '');
  try { return JSON.parse(raw); } catch {}
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(raw.slice(first, last + 1)); } catch {}
  }
  return null;
}
function resultText(result) {
  return String(result?.content || result?.text || result?.response || result?.message?.content || '').trim();
}

function freshStats() {
  return {
    enabled: enabled(),
    attempted: false,
    maxCalls: 0,
    modelCalls: 0,
    modelAttempts: 0,
    contextCalls: 0,
    selectionCalls: 0,
    reviewerCalls: 0,
    modelFailures: 0,
    actualModels: [],
    directProvidersUsed: [],
    directAttemptAudit: [],
    rowsConsidered: 0,
    requestedResidueRows: [],
    skippedReason: '',
    rowsWithKnownEmployer: 0,
    employersResolvedByAi: 0,
    employerOverridesByAi: 0,
    employerAbstains: 0,
    employerEvidenceRejects: 0,
    candidateSearches: 0,
    candidateCacheHits: 0,
    candidatesDiscovered: 0,
    linkedinFallbackSearches: 0,
    linkedinFallbackFailures: 0,
    linkedinFallbackProfilesFound: 0,
    linkedinFallbackVerifiedCandidates: 0,
    rowsOfferedForSelection: 0,
    slotsOfferedForSelection: 0,
    aiSelectionsProposed: 0,
    aiSelectionsAccepted: 0,
    aiSelectionRejects: 0,
    reviewerTriggered: false,
    reviewerRows: 0,
    hydrationAttempts: 0,
    hydrationFailures: 0,
    identityDuplicatesSkipped: 0,
    rowsChanged: 0,
    cellsChanged: 0,
    newPeopleSelected: 0,
    existingRepairsAccepted: 0,
    embeddedDesignationWrites: 0,
    pendingPhoneRequests: 0,
    phoneSyncPolls: 0,
    phoneSyncErrors: 0,
    phoneSyncLastError: null,
    phoneCellsFilled: 0,
    phoneRowsChanged: 0,
    phoneNotFound: 0,
    phoneWriteSkippedPopulated: 0,
    phoneStillPending: 0,
    unresolvedSlots: 0,
    unresolvedRows: [],
    unresolvedReasons: [],
    selectionAudit: [],
    errors: [],
    personalApiFallbacks: 0,
  };
}

function markUnresolved(stats, rowNumber, reason, detail = '') {
  const row = Number(rowNumber);
  if (Number.isInteger(row) && !stats.unresolvedRows.includes(row)) stats.unresolvedRows.push(row);
  stats.unresolvedReasons.push({
    rowNumber: Number.isInteger(row) ? row : null,
    reason: text(reason || 'unresolved'),
    detail: text(detail).slice(0, 300),
  });
}

function providerName(model) {
  return text(direct.providerForModel(model)).toLowerCase();
}

function allowedDirectProviders() {
  const configured = String(process.env.ULTRON_M3_UNIVERSAL_AI_DIRECT_PROVIDERS || 'gemini,groq,nvidia')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .map((value) => value === 'grok' ? 'groq' : value);
  return [...new Set(configured)];
}

function orderedDirectCandidates(candidates, purpose, stats) {
  const allow = new Set(allowedDirectProviders());
  const rows = [...new Set(Array.isArray(candidates) ? candidates : [])]
    .filter((model) => allow.has(providerName(model)));
  if (!rows.length) return [];

  const firstPerProvider = new Map();
  for (const model of rows) {
    const provider = providerName(model);
    if (provider && !firstPerProvider.has(provider)) firstPerProvider.set(provider, model);
  }

  const previouslyUsed = new Set((stats.directProvidersUsed || []).map((value) => text(value).toLowerCase()).filter(Boolean));
  const purposePreference = purpose === 'context'
    ? ['gemini', 'groq', 'nvidia']
    : purpose === 'selection'
      ? ['groq', 'gemini', 'nvidia']
      : ['nvidia', 'gemini', 'groq'];

  return [...firstPerProvider.entries()]
    .map(([provider, model], index) => {
      const preferenceIndex = purposePreference.indexOf(provider);
      const unusedBonus = previouslyUsed.has(provider) ? 0 : 1000;
      const preferenceScore = preferenceIndex < 0 ? 0 : 300 - preferenceIndex * 100;
      return { model, provider, index, score: unusedBonus + preferenceScore };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.model);
}

async function batchChat(messages, purpose, stats, options = {}) {
  if (purpose === 'context') stats.contextCalls++;
  if (purpose === 'selection') stats.selectionCalls++;
  if (purpose === 'review') stats.reviewerCalls++;

  let candidates = [];
  try {
    candidates = orderedDirectCandidates(await direct.candidates('research', { envOnly: true }), purpose, stats);
  } catch (error) {
    stats.modelFailures++;
    stats.errors.push({
      purpose,
      code: text(error?.code || 'DIRECT_PROVIDER_DISCOVERY_FAILED'),
      message: text(error?.message || error).slice(0, 500),
    });
    return null;
  }

  if (!candidates.length) {
    stats.modelFailures++;
    stats.errors.push({
      purpose,
      code: 'DIRECT_PROVIDER_NOT_CONFIGURED',
      message: `No env-backed direct AI provider/model is available for research inference from allowed providers: ${allowedDirectProviders().join(', ')}.`,
    });
    return null;
  }

  return control.runInternalInference('spreadsheet-enrichment', async () => {
    for (const model of candidates) {
      if (stats.modelAttempts >= stats.maxCalls) return null;
      stats.modelAttempts++;

      const provider = providerName(model) || 'direct';
      try {
        const result = await direct.chat({
          model,
          taskType: 'research',
          messages,
          timeoutMs: direct.timeoutFor('research'),
          envOnly: true,
        });

        const body = resultText(result);
        if (!body) {
          const error = new Error('Direct env-backed model returned no usable final text.');
          error.code = 'DIRECT_AI_EMPTY_RESPONSE';
          throw error;
        }

        const actual = text(result?.model || model);
        const actualProvider = text(result?.provider || provider);
        if (actual && !stats.actualModels.includes(actual)) stats.actualModels.push(actual);
        if (actualProvider && !stats.directProvidersUsed.includes(actualProvider)) stats.directProvidersUsed.push(actualProvider);
        stats.directAttemptAudit.push({
          purpose,
          provider: actualProvider,
          model: actual,
          success: true,
          credentialSlot: text(result?.credentialSlot || ''),
          envOnly: true,
        });
        stats.modelCalls++;
        return result;
      } catch (error) {
        stats.modelFailures++;
        stats.directAttemptAudit.push({
          purpose,
          provider,
          model,
          success: false,
          code: text(error?.code || error?.status || 'DIRECT_AI_FAILED'),
          message: text(error?.message || error).slice(0, 300),
        });
        stats.errors.push({
          purpose,
          provider,
          model,
          code: text(error?.code || 'DIRECT_AI_FAILED'),
          message: text(error?.message || error).slice(0, 500),
        });
      }
    }
    return null;
  });
}

function compactEvidence(row, schema, plan) {
  const fields = [];
  const max = Math.min(Math.max((row || []).length, (schema?.columns || []).length), 40);
  for (let i = 0; i < max; i++) {
    const value = text(row?.[i]);
    if (!value) continue;
    const header = text(schema?.columns?.find((column) => column.index === i)?.header || '');
    fields.push({ columnIndex: i, header, value: value.slice(0, 2500) });
  }
  return {
    anchorName: text(plan?.anchor?.snapshot?.values?.name),
    anchorLinkedin: text(plan?.anchor?.snapshot?.values?.linkedin),
    context: plan?.context || {},
    fields,
  };
}

function normalizedHaystack(evidence) {
  return ranker.normalize((evidence?.fields || []).map((item) => item.value).join(' '));
}

function companySupported(company, evidence) {
  const expected = ranker.companyKey(company);
  const haystack = normalizedHaystack(evidence);
  if (!expected || !haystack) return false;
  if (haystack.includes(expected)) return true;
  const tokens = expected.split(' ').filter((token) => token.length >= 2);
  if (!tokens.length) return false;
  const matched = tokens.filter((token) => haystack.includes(token)).length;
  return matched / tokens.length >= (tokens.length <= 2 ? 1 : 0.8);
}

function contextRowsFromOutput(output) {
  const list = Array.isArray(output?.rows) ? output.rows : [];
  const map = new Map();
  for (const item of list) {
    const rowNumber = Number(item?.rowNumber);
    if (!Number.isInteger(rowNumber)) continue;
    map.set(rowNumber, {
      rowNumber,
      company: text(item?.company),
      hiringContext: text(item?.hiringContext).slice(0, 1800),
      confidence: Math.max(0, Math.min(1, Number(item?.confidence || 0))),
      reason: text(item?.reason).slice(0, 500),
    });
  }
  return map;
}

function localCandidateScore(candidate, context = {}) {
  const title = ranker.normalize(candidate?.title || candidate?.headline || '');
  const all = ranker.normalize([
    candidate?.title,
    candidate?.headline,
    ...(Array.isArray(candidate?.functions) ? candidate.functions : []),
    ...(Array.isArray(candidate?.departments) ? candidate.departments : []),
  ].filter(Boolean).join(' '));
  let score = 0;
  if (/founder|owner|director/.test(title)) score += 95;
  if (/head.*(?:recruit|talent|hr|people)|(?:recruit|talent|hr|people).*head/.test(all)) score += 88;
  if (/manager.*(?:recruit|talent|hr|people)|(?:recruit|talent|hr|people).*manager/.test(all)) score += 82;
  if (/recruit|talent acquisition|human resources|\bhr\b|people/.test(all)) score += 68;
  if (/lead|manager|director|head|founder|owner/.test(title)) score += 18;
  const requirement = ranker.normalize(context.hiringContext || '');
  for (const token of ranker.tokenList(requirement).slice(0, 20)) {
    if (token.length >= 3 && all.includes(token)) score += 3;
  }
  if (candidate?.id || candidate?.apolloPersonId) score += 5;
  if (candidate?.linkedinUrl) score += 4;
  return score;
}

function compactCandidate(candidate) {
  return {
    candidateKey: text(candidate?.apolloPersonId || candidate?.id || candidate?.linkedinUrl || candidate?.linkedin_url),
    name: text(candidate?.name),
    title: text(candidate?.title),
    headline: text(candidate?.headline).slice(0, 300),
    seniority: text(candidate?.seniority),
    functions: Array.isArray(candidate?.functions) ? candidate.functions.slice(0, 6) : [],
    departments: Array.isArray(candidate?.departments) ? candidate.departments.slice(0, 6) : [],
  };
}

function shortlistCandidates(candidates, context, limit) {
  const seen = new Set();
  return [...(candidates || [])]
    .filter((candidate) => candidate && (candidate.id || candidate.apolloPersonId || candidate.linkedinUrl))
    .map((candidate, index) => ({ candidate, index, score: localCandidateScore(candidate, context) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .filter((entry) => {
      const key = text(entry.candidate.apolloPersonId || entry.candidate.id || entry.candidate.linkedinUrl).toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit)
    .map((entry) => entry.candidate);
}

function rescueTargets(plan) {
  const wantedOrdinal = 2;
  return (plan?.groups?.open || [])
    .filter((item) => !item.isAnchor && Number(item.group?.ordinal || 0) === wantedOrdinal)
    .map((item) => ({ ...item, rescueMode: 'fill' }));
}

function candidatePoolForTargets(candidates, targets, context, limit) {
  return shortlistCandidates(candidates, context, limit);
}

function existingIdentitySet(plan) {
  return base.existingIdentityKeys(plan);
}

function assignmentRows(output) {
  if (Array.isArray(output)) return output;
  for (const key of ['rows', 'results', 'selections', 'items']) {
    if (Array.isArray(output?.[key])) return output[key];
  }
  return [];
}

function validateAssignments(output, rowPackages) {
  const rows = assignmentRows(output);
  const validated = new Map();

  for (const item of rows) {
    const rowNumber = Number(item?.rowNumber ?? item?.row ?? item?.row_number);
    const pkg = rowPackages.get(rowNumber);
    if (!pkg || pkg.targets.length !== 1) continue;

    const target = pkg.targets[0];
    const allowedEntries = pkg.candidates.map((candidate) => ({
      key: text(candidate.apolloPersonId || candidate.id || candidate.linkedinUrl || candidate.linkedin_url),
      candidate,
      name: planner.normalizeName(candidate?.name || ''),
    })).filter((entry) => entry.key);
    const byKey = new Map(allowedEntries.map((entry) => [entry.key.toLowerCase(), entry]));

    let proposals = Array.isArray(item?.assignments) ? item.assignments : null;
    if (!proposals) {
      proposals = [{
        candidateKey: item?.candidateKey ?? item?.candidate_id ?? item?.candidateId ?? item?.id,
        candidateName: item?.candidateName ?? item?.name,
        confidence: item?.confidence,
        reason: item?.reason,
      }];
    }

    const assignments = [];
    for (const proposal of proposals) {
      let candidateKey = text(proposal?.candidateKey ?? proposal?.candidate_id ?? proposal?.candidateId ?? proposal?.id);
      let entry = candidateKey ? byKey.get(candidateKey.toLowerCase()) : null;

      if (!entry) {
        const wantedName = planner.normalizeName(proposal?.candidateName ?? proposal?.name ?? '');
        const matches = wantedName ? allowedEntries.filter((candidate) => candidate.name === wantedName) : [];
        if (matches.length === 1) {
          entry = matches[0];
          candidateKey = entry.key;
        }
      }
      if (!entry) continue;

      assignments.push({
        target,
        candidate: entry.candidate,
        candidateKey,
        confidence: Math.max(0, Math.min(1, Number(proposal?.confidence || 0.7))),
        reason: text(proposal?.reason).slice(0, 500),
      });
      break;
    }
    validated.set(rowNumber, assignments);
  }
  return validated;
}

function reviewerNeeded(assignments, rowPackages) {
  for (const [rowNumber, pkg] of rowPackages.entries()) {
    const selected = assignments.get(rowNumber) || [];
    if (selected.length < pkg.targets.length) return true;
    if (selected.some((item) => item.confidence < 0.58)) return true;
  }
  return false;
}

async function deterministicCompany(plan, row, options = {}) {
  if (!plan?.anchor) return null;

  const rowEvidence = base.inferHiringCompanyFromEvidence(plan, row);
  if (rowEvidence?.company || rowEvidence?.domain) return rowEvidence;

  let anchorContext = null;
  if (plan.anchor.type === 'company') {
    anchorContext = base.companyFromCompanyAnchor(plan.anchor);
  } else {
    try { anchorContext = await base.resolvePersonAnchor(plan, row, options); } catch {}
  }
  return anchorContext && !anchorContext.unresolved && (anchorContext.company || anchorContext.domain)
    ? anchorContext
    : null;
}

async function run(request = {}, primaryResult = {}, options = {}) {
  const stats = freshStats();
  stats.maxCalls = maxCalls(options);
  if (!stats.enabled || options.dryRun || options.apolloApproved !== true) return stats;

  const exactResidueRows = [...new Set(
    (primaryResult?.stats?.deferredPoc2Rows || [])
      .map((value) => Number(value))
      .filter(Number.isInteger)
  )];
  stats.requestedResidueRows = exactResidueRows;
  if (!exactResidueRows.length) {
    stats.skippedReason = 'no-primary-poc2-residue';
    return stats;
  }
  const residueSet = new Set(exactResidueRows);
  stats.attempted = true;

  const source = await base.readUniversalSheet(request.sheetUrl || request.url, {
    ...options,
    sheetName: request.sheetName || options.sheetName,
  });
  const analysis = engine.analyzeSheet(source.rows, { rowLimit: options.rowLimit, schema: options.schema });
  const discoveryCache = options.discoveryCache instanceof Map ? options.discoveryCache : new Map();

  const rowRecords = new Map();
  const contextInput = [];
  for (const record of analysis.rowPlans) {
    const { row, rowNumber, plan } = record;
    if (!residueSet.has(Number(rowNumber))) continue;
    const targets = rescueTargets(plan);
    if (!plan.anchor || !targets.length) continue;
    stats.rowsConsidered++;
    const evidence = compactEvidence(row, source.schema, plan);
    const knownCompany = await deterministicCompany(plan, row, options);
    if (knownCompany?.company) stats.rowsWithKnownEmployer++;
    rowRecords.set(rowNumber, { ...record, evidence, knownCompany, targets });
    contextInput.push({
      rowNumber,
      knownCompany: knownCompany?.company || '',
      knownDomain: knownCompany?.domain || '',
      unresolvedEmployer: !knownCompany?.company,
      anchorName: evidence.anchorName,
      anchorLinkedin: evidence.anchorLinkedin,
      fields: evidence.fields,
    });
  }

  if (!rowRecords.size) return stats;

  // Context AI is optional. If deterministic anchor evidence already resolved the
  // employer, skip this entire model call and go straight to POC-2 selection.
  const unresolvedContextInput = contextInput.filter((item) => item.unresolvedEmployer);
  let contextMap = new Map();
  if (unresolvedContextInput.length) {
    const contextResult = await batchChat([
      {
        role: 'system',
        content: [
          'You are ULTRON Spreadsheet Context Analyst.',
          'Analyze only rows whose employer is unresolved.',
          'For each row, identify the target hiring organization from the supplied spreadsheet evidence only.',
          'Never invent a company from general knowledge.',
          'Return strict JSON only: {"rows":[{"rowNumber":2,"company":"","hiringContext":"","confidence":0.0,"reason":""}]}.',
        ].join(' '),
      },
      { role: 'user', content: JSON.stringify({ rows: unresolvedContextInput }) },
    ], 'context', stats, options);
    contextMap = contextRowsFromOutput(parseJson(resultText(contextResult)) || {});
  }

  const rowPackages = new Map();
  const discoveryStats = base.freshStats();
  const uniqueCandidateKeys = new Set();
  for (const [rowNumber, record] of rowRecords.entries()) {
    const aiContext = contextMap.get(rowNumber);
    let companyContext = record.knownCompany;
    if (aiContext?.company) {
      const aiSupported = companySupported(aiContext.company, record.evidence);
      const aiKey = ranker.companyKey(aiContext.company);
      const knownKey = ranker.companyKey(record.knownCompany?.company || '');
      const differsFromKnown = Boolean(aiKey && knownKey && aiKey !== knownKey);
      if (!companyContext?.company) {
        if (aiContext.confidence >= 0.6 && aiSupported) {
          companyContext = {
            company: aiContext.company,
            domain: '',
            source: 'ai-batch-row-evidence',
            anchorLinkedin: text(record.plan?.anchor?.snapshot?.values?.linkedin),
            anchorApolloPersonId: '',
            anchorPerson: null,
          };
          stats.employersResolvedByAi++;
        } else {
          stats.employerEvidenceRejects++;
        }
      } else if (differsFromKnown && aiContext.confidence >= 0.82 && aiSupported) {
        companyContext = {
          company: aiContext.company,
          domain: '',
          source: 'ai-batch-explicit-hiring-company-override',
          anchorLinkedin: text(record.plan?.anchor?.snapshot?.values?.linkedin),
          anchorApolloPersonId: '',
          anchorPerson: null,
        };
        stats.employerOverridesByAi++;
      }
    }
    if (!companyContext?.company) {
      stats.employerAbstains++;
      stats.unresolvedSlots += record.targets.length;
      markUnresolved(stats, rowNumber, 'employer-unresolved', 'No verified hiring employer could be resolved from deterministic or supplied row evidence.');
      continue;
    }

    let people = [];
    try {
      people = await base.discoverPriorityPeopleFast(companyContext, discoveryCache, discoveryStats, {
        ...options,
        location: record.plan?.context?.location || '',
        priorityCandidateLimit: options.manualPriorityCandidateLimit ?? 20,
        adaptiveBroadCandidateLimit: options.adaptiveBroadCandidateLimit ?? 30,
      });
    } catch (error) {
      stats.errors.push({ purpose: 'discovery', rowNumber, code: text(error?.code), message: text(error?.message).slice(0, 300) });
      stats.unresolvedSlots += record.targets.length;
      markUnresolved(stats, rowNumber, 'apollo-discovery-failed', text(error?.message || error));
      continue;
    }

    for (const candidate of people || []) {
      const key = text(candidate?.apolloPersonId || candidate?.id || candidate?.linkedinUrl || candidate?.linkedin_url).toLowerCase();
      if (key) uniqueCandidateKeys.add(key);
    }
    const hiringContext = aiContext?.hiringContext || text(record.plan?.context?.postDetails || record.plan?.context?.details || '');
    const shortlisted = candidatePoolForTargets(people || [], record.targets, { hiringContext }, candidateLimit(options));
    if (!shortlisted.length) {
      stats.unresolvedSlots += record.targets.length;
      markUnresolved(stats, rowNumber, 'no-verified-candidates', 'Apollo discovery returned no candidate that survived the POC-2 shortlist.');
      continue;
    }

    rowPackages.set(rowNumber, {
      ...record,
      companyContext,
      hiringContext,
      candidates: shortlisted,
    });
  }

  stats.candidateSearches = discoveryStats.candidateSearches || 0;
  stats.candidateCacheHits = discoveryStats.candidateCacheHits || 0;
  stats.candidatesDiscovered = uniqueCandidateKeys.size;
  stats.linkedinFallbackSearches = discoveryStats.linkedinFallbackSearches || 0;
  stats.linkedinFallbackFailures = discoveryStats.linkedinFallbackFailures || 0;
  stats.linkedinFallbackProfilesFound = discoveryStats.linkedinFallbackProfilesFound || 0;
  stats.linkedinFallbackVerifiedCandidates = discoveryStats.linkedinFallbackVerifiedCandidates || 0;
  stats.rowsOfferedForSelection = rowPackages.size;
  stats.slotsOfferedForSelection = [...rowPackages.values()].reduce((sum, pkg) => sum + pkg.targets.length, 0);
  if (!rowPackages.size || stats.modelAttempts >= stats.maxCalls) {
    for (const rowNumber of exactResidueRows) {
      if (!rowPackages.has(rowNumber) && !stats.unresolvedRows.includes(rowNumber)) {
        markUnresolved(stats, rowNumber, 'not-offered-to-selection', 'POC-2 residue could not reach candidate selection.');
      }
    }
    return stats;
  }

  const selectionInput = [...rowPackages.entries()].map(([rowNumber, pkg]) => {
    const target = pkg.targets[0];
    return {
      rowNumber,
      company: pkg.companyContext.company,
      hiringContext: pkg.hiringContext,
      existingPeople: [...existingIdentitySet(pkg.plan).names],
      target: {
        mode: 'fill',
        missingFields: target.snapshot?.missingFields || [],
      },
      candidates: pkg.candidates.map((candidate) => {
        const compact = compactCandidate(candidate);
        return {
          candidateKey: compact.candidateKey,
          name: compact.name,
          title: compact.title,
          seniority: compact.seniority,
        };
      }),
    };
  });

  // PASS 2: one batch selection call for all unresolved slots.
  const selectionResult = await batchChat([
    {
      role: 'system',
      content: [
        'You are ULTRON Batch POC Selector.',
        'Select exactly one POC-2 candidate for each supplied row when a safe choice exists.',
        'You may choose ONLY candidateKey values supplied inside that same row.',
        'Never choose anyone already listed in existingPeople.',
        'Priority: Founder/Director/Owner, then recruiting/talent/HR Head or Manager, then Recruiter, while respecting real hiring relevance.',
        'Return compact strict JSON only: {"rows":[{"rowNumber":2,"candidateKey":"...","confidence":0.0,"reason":""}]}.',
      ].join(' '),
    },
    { role: 'user', content: JSON.stringify({ rows: selectionInput }) },
  ], 'selection', stats, options);

  let assignments = validateAssignments(parseJson(resultText(selectionResult)) || {}, rowPackages);
  stats.aiSelectionsProposed = [...assignments.values()].reduce((sum, list) => sum + list.length, 0);

  // PASS 3: reviewer only when selection is incomplete/weak and budget allows it.
  const reviewerEnabled = /^(1|true|yes|on)$/i.test(String(process.env.ULTRON_M3_UNIVERSAL_AI_REVIEWER || '0'));
  if (reviewerEnabled && stats.modelAttempts < stats.maxCalls && reviewerNeeded(assignments, rowPackages)) {
    stats.reviewerTriggered = true;
    const reviewRows = [...rowPackages.entries()].filter(([rowNumber, pkg]) => {
      const selected = assignments.get(rowNumber) || [];
      return selected.length < pkg.targets.length || selected.some((item) => item.confidence < 0.58);
    });
    stats.reviewerRows = reviewRows.length;
    const reviewInput = reviewRows.map(([rowNumber, pkg]) => ({
      rowNumber,
      company: pkg.companyContext.company,
      hiringContext: pkg.hiringContext,
      targets: pkg.targets.map((target) => ({
        slot: String(target.group.ordinal || target.group.id),
        mode: 'fill',
        missingFields: target.snapshot?.missingFields || [],
      })),
      firstPass: (assignments.get(rowNumber) || []).map((item) => ({
        slot: String(item.target.group.ordinal || item.target.group.id),
        candidateKey: item.candidateKey,
        confidence: item.confidence,
        reason: item.reason,
      })),
      candidates: pkg.candidates.map(compactCandidate),
    }));
    const reviewResult = await batchChat([
      {
        role: 'system',
        content: [
          'You are ULTRON Independent Batch POC Reviewer.',
          'Review only the supplied weak/incomplete rows.',
          'Select ONLY supplied candidateKey values. Never invent people.',
          'Return the strongest complete target assignments you can justify from the row hiring context.',
          'Do not reuse an existing row identity.',
          'Keep unique people per row and abstain rather than fabricate.',
          'Return strict JSON only in the exact same {"rows":[...]} schema as the first selector.',
        ].join(' '),
      },
      { role: 'user', content: JSON.stringify({ rows: reviewInput }) },
    ], 'review', stats, options);
    const reviewed = validateAssignments(parseJson(resultText(reviewResult)) || {}, new Map(reviewRows));
    for (const [rowNumber, list] of reviewed.entries()) if (list.length) assignments.set(rowNumber, list);
  }

  const pendingPhoneQueue = [];
  const changedRows = new Set();

  for (const [rowNumber, pkg] of rowPackages.entries()) {
    const proposed = assignments.get(rowNumber) || [];
    const existing = existingIdentitySet(pkg.plan);
    const claimed = new Set();

    for (const assignment of proposed) {
      if (claimed.has(assignment.candidateKey)) continue;
      stats.hydrationAttempts++;
      let person = null;
      try {
        person = await apollo.resolveDecisionMaker(
          assignment.candidate,
          pkg.companyContext.company,
          pkg.companyContext.domain,
          {
            needEmail: Boolean(assignment.target.group.fields.email),
            needPhone: Boolean(assignment.target.group.fields.phone),
          },
        );
      } catch (error) {
        stats.hydrationFailures++;
        stats.aiSelectionRejects++;
        stats.errors.push({
          purpose: 'hydration',
          rowNumber,
          candidateKey: assignment.candidateKey,
          code: text(error?.code),
          message: text(error?.message).slice(0, 300),
        });
        continue;
      }

      if (!person?.identityVerified || !person?.title || !ranker.sameEmployer(person, pkg.companyContext)) {
        stats.hydrationFailures++;
        stats.aiSelectionRejects++;
        continue;
      }

      const nameKey = ranker.normalize(person.name || '');
      const linkedinKey = ranker.linkedinKey(person.linkedinUrl || person.returnedLinkedIn || '');
      if ((nameKey && existing.names.has(nameKey)) || (linkedinKey && existing.linkedins.has(linkedinKey))) {
        stats.identityDuplicatesSkipped++;
        stats.aiSelectionRejects++;
        continue;
      }

      const writePlan = planner.safeWritesForGroup(pkg.row, assignment.target.group, person);
      if (!writePlan.allowed) {
        stats.aiSelectionRejects++;
        continue;
      }

      const queueBefore = pendingPhoneQueue.length;
      base.queuePendingPhone(
        { pendingPhoneQueue },
        rowNumber,
        assignment.target.group,
        assignment.target.snapshot,
        person,
      );
      const queuedPendingPhone = pendingPhoneQueue.length > queueBefore;

      // A selected fill can still be useful when Apollo's phone is asynchronous
      // and there is no immediate phone write. Keep the verified assignment alive
      // so the end-of-run webhook sync can complete the phone cell.
      if (!writePlan.writes.length && !queuedPendingPhone) {
        stats.aiSelectionRejects++;
        continue;
      }

      const byColumn = new Map();
      for (const write of writePlan.writes) if (!byColumn.has(write.columnIndex)) byColumn.set(write.columnIndex, write);
      const changes = [...byColumn.values()].map((write) => ({
        range: sheets.cellRange(source.sheetName, rowNumber, write.columnIndex),
        value: write.value,
      }));
      if (changes.length) {
        await sheets.writeCells(source.spreadsheetId, changes);
        changedRows.add(rowNumber);
        stats.cellsChanged += changes.length;
      }
      stats.newPeopleSelected++;
      stats.aiSelectionsAccepted++;
      stats.embeddedDesignationWrites += writePlan.writes.filter((write) => write.embeddedRole).length;
      stats.selectionAudit.push({
        rowNumber,
        groupId: assignment.target.group.id,
        slot: assignment.target.group.ordinal || null,
        mode: 'fill',
        candidateKey: assignment.candidateKey,
        name: text(person.name),
        title: text(person.title),
        confidence: assignment.confidence,
        reason: assignment.reason,
        fields: writePlan.writes.length
          ? writePlan.writes.map((write) => write.field)
          : (queuedPendingPhone ? ['phone-pending'] : []),
      });
      claimed.add(assignment.candidateKey);
      if (nameKey) existing.names.add(nameKey);
      if (linkedinKey) existing.linkedins.add(linkedinKey);
    }

    const acceptedForRow = stats.selectionAudit.filter((item) => item.rowNumber === rowNumber).length;
    const remaining = Math.max(0, pkg.targets.length - acceptedForRow);
    stats.unresolvedSlots += remaining;
    if (remaining > 0) {
      const proposedForRow = proposed.length;
      markUnresolved(
        stats,
        rowNumber,
        proposedForRow ? 'selection-rejected-after-verification' : 'ai-selection-abstained',
        proposedForRow
          ? 'AI proposed a supplied Apollo candidate, but deterministic hydration/identity/employer/write verification did not accept it.'
          : 'Direct AI returned no accepted supplied candidate for this POC-2 target.',
      );
    }
  }

  stats.rowsChanged = changedRows.size;

  const acceptedRows = new Set(stats.selectionAudit.map((item) => Number(item.rowNumber)).filter(Number.isInteger));
  stats.unresolvedRows = stats.unresolvedRows.filter((rowNumber) => !acceptedRows.has(Number(rowNumber)));
  stats.unresolvedReasons = stats.unresolvedReasons.filter((item) => !acceptedRows.has(Number(item.rowNumber)));

  try {
    await base.syncPendingPhoneAssignments(source, pendingPhoneQueue, stats, options);
  } catch (error) {
    stats.phoneSyncErrors++;
    stats.phoneSyncLastError = base.typedFailureSummary(error, { stage: 'ai-batch-phone-result-sync' });
  }

  return stats;
}

module.exports = {
  enabled,
  maxCalls,
  freshStats,
  compactEvidence,
  companySupported,
  shortlistCandidates,
  rescueTargets,
  candidatePoolForTargets,
  assignmentRows,
  validateAssignments,
  reviewerNeeded,
  allowedDirectProviders,
  orderedDirectCandidates,
  run,
};
