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
const modelRouter = require('./model-router');
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
  const raw = Number(options.aiCandidateLimit ?? process.env.ULTRON_M3_UNIVERSAL_AI_BATCH_CANDIDATES ?? 12);
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
    contextCalls: 0,
    selectionCalls: 0,
    reviewerCalls: 0,
    modelFailures: 0,
    actualModels: [],
    rowsConsidered: 0,
    rowsWithKnownEmployer: 0,
    employersResolvedByAi: 0,
    employerOverridesByAi: 0,
    employerAbstains: 0,
    employerEvidenceRejects: 0,
    candidateSearches: 0,
    candidateCacheHits: 0,
    candidatesDiscovered: 0,
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
    selectionAudit: [],
    errors: [],
    personalApiFallbacks: 0,
  };
}

async function batchChat(messages, purpose, stats, options = {}) {
  if (stats.modelCalls >= stats.maxCalls) return null;
  stats.modelCalls++;
  if (purpose === 'context') stats.contextCalls++;
  if (purpose === 'selection') stats.selectionCalls++;
  if (purpose === 'review') stats.reviewerCalls++;
  try {
    return await control.runInternalInference('spreadsheet-enrichment', async () => {
      const result = await modelRouter.chatOmniRouteOnly({
        model: 'auto/best-reasoning',
        taskType: 'research',
        messages,
      });
      const actual = text(result?.model || result?.raw?.model || 'omniroute-auto');
      if (actual && !stats.actualModels.includes(actual)) stats.actualModels.push(actual);
      return result;
    });
  } catch (error) {
    stats.modelFailures++;
    stats.errors.push({
      purpose,
      code: text(error?.code || 'AI_BATCH_REASONING_FAILED'),
      message: text(error?.message || error).slice(0, 400),
    });
    return null;
  }
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
  const open = (plan?.groups?.open || [])
    .filter((item) => !item.isAnchor)
    .map((item) => ({ ...item, rescueMode: 'fill' }));
  const repair = (plan?.groups?.partial || [])
    .filter((item) => !item.isAnchor && item.snapshot?.hasIdentity)
    .map((item) => ({ ...item, rescueMode: 'repair' }));
  return [...repair, ...open]
    .sort((a, b) => (a.group.ordinal || 999) - (b.group.ordinal || 999));
}

function exactRepairCandidate(target, candidate) {
  if (target?.rescueMode !== 'repair') return false;
  const existingName = planner.normalizeName(target?.snapshot?.values?.name || '');
  const candidateName = planner.normalizeName(candidate?.name || '');
  const existingLinkedin = ranker.linkedinKey(target?.snapshot?.values?.linkedin || '');
  const candidateLinkedin = ranker.linkedinKey(candidate?.linkedinUrl || candidate?.linkedin_url || '');
  if (existingLinkedin && candidateLinkedin) return existingLinkedin === candidateLinkedin;
  return Boolean(existingName && candidateName && existingName === candidateName);
}

function candidatePoolForTargets(candidates, targets, context, limit) {
  const chosen = [];
  const seen = new Set();
  const keyOf = (candidate) => text(candidate?.apolloPersonId || candidate?.id || candidate?.linkedinUrl || candidate?.linkedin_url).toLowerCase();
  const add = (candidate) => {
    const key = keyOf(candidate);
    if (!key || seen.has(key) || chosen.length >= limit) return;
    seen.add(key);
    chosen.push(candidate);
  };

  // Existing partial POCs get first-class representation in the AI batch even
  // when their titles are not high enough to survive authority pre-ranking.
  for (const target of targets || []) {
    if (target?.rescueMode !== 'repair') continue;
    for (const candidate of candidates || []) {
      if (exactRepairCandidate(target, candidate)) add(candidate);
    }
  }
  for (const candidate of shortlistCandidates(candidates, context, limit)) add(candidate);
  return chosen.slice(0, limit);
}

function existingIdentitySet(plan) {
  return base.existingIdentityKeys(plan);
}

function validateAssignments(output, rowPackages) {
  const rows = Array.isArray(output?.rows) ? output.rows : [];
  const validated = new Map();
  for (const item of rows) {
    const rowNumber = Number(item?.rowNumber);
    const pkg = rowPackages.get(rowNumber);
    if (!pkg) continue;
    const allowed = new Map(pkg.candidates.map((candidate) => [
      text(candidate.apolloPersonId || candidate.id || candidate.linkedinUrl || candidate.linkedin_url),
      candidate,
    ]));
    const slots = new Map(pkg.targets.map((target) => [String(target.group.ordinal || target.group.id), target]));
    const assignments = [];
    const claimed = new Set();
    for (const proposal of Array.isArray(item?.assignments) ? item.assignments : []) {
      const slotKey = String(proposal?.slot ?? proposal?.ordinal ?? '');
      const target = slots.get(slotKey);
      const candidateKey = text(proposal?.candidateKey);
      const candidate = allowed.get(candidateKey);
      if (!target || !candidate || claimed.has(candidateKey)) continue;
      claimed.add(candidateKey);
      assignments.push({
        target,
        candidate,
        candidateKey,
        confidence: Math.max(0, Math.min(1, Number(proposal?.confidence || 0))),
        reason: text(proposal?.reason).slice(0, 500),
      });
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
  if (plan.anchor.type === 'company') {
    const value = base.companyFromCompanyAnchor(plan.anchor);
    return value?.company ? value : null;
  }
  try {
    const value = await base.resolvePersonAnchor(plan, row, options);
    return value && !value.unresolved && value.company ? value : null;
  } catch {
    return null;
  }
}

async function run(request = {}, primaryResult = {}, options = {}) {
  const stats = freshStats();
  stats.maxCalls = maxCalls(options);
  if (!stats.enabled || options.dryRun || options.apolloApproved !== true) return stats;
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

  // PASS 1: one batch interpretation call for every unresolved row.
  const contextResult = await batchChat([
    {
      role: 'system',
      content: [
        'You are ULTRON Spreadsheet Context Analyst.',
        'Analyze ALL supplied rows in one batch.',
        'For each row, identify the TARGET HIRING ORGANIZATION whose employees should become the additional POCs, and summarize the hiring context.',
        'The post author\'s current employer and the target hiring organization may be different. If the row explicitly says a role is for/join/at another company, prefer that explicit hiring company for POC discovery.',
        'If knownCompany is supplied, use it as strong evidence but you may override it only when a different hiring company is explicitly named in the supplied row fields.',
        'If knownCompany is empty, choose a company ONLY when its wording is directly supported by the supplied row fields.',
        'Never infer a company from general knowledge.',
        'Return strict JSON only: {"rows":[{"rowNumber":2,"company":"","hiringContext":"","confidence":0.0,"reason":""}]}.',
      ].join(' '),
    },
    { role: 'user', content: JSON.stringify({ rows: contextInput }) },
  ], 'context', stats, options);
  const contextMap = contextRowsFromOutput(parseJson(resultText(contextResult)) || {});

  const rowPackages = new Map();
  const discoveryStats = base.freshStats();
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
      continue;
    }

    let people = [];
    try {
      people = await base.discoverCompanyPeople(companyContext, discoveryCache, discoveryStats, {
        ...options,
        location: record.plan?.context?.location || '',
      });
    } catch (error) {
      stats.errors.push({ purpose: 'discovery', rowNumber, code: text(error?.code), message: text(error?.message).slice(0, 300) });
      stats.unresolvedSlots += record.targets.length;
      continue;
    }

    const hiringContext = aiContext?.hiringContext || text(record.plan?.context?.postDetails || record.plan?.context?.details || '');
    const shortlisted = candidatePoolForTargets(people || [], record.targets, { hiringContext }, candidateLimit(options));
    if (!shortlisted.length) {
      stats.unresolvedSlots += record.targets.length;
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
  stats.candidatesDiscovered = discoveryStats.candidatesDiscovered || 0;
  stats.rowsOfferedForSelection = rowPackages.size;
  stats.slotsOfferedForSelection = [...rowPackages.values()].reduce((sum, pkg) => sum + pkg.targets.length, 0);
  if (!rowPackages.size || stats.modelCalls >= stats.maxCalls) return stats;

  const selectionInput = [...rowPackages.entries()].map(([rowNumber, pkg]) => ({
    rowNumber,
    company: pkg.companyContext.company,
    hiringContext: pkg.hiringContext,
    anchor: {
      name: text(pkg.plan?.anchor?.snapshot?.values?.name),
      linkedin: text(pkg.plan?.anchor?.snapshot?.values?.linkedin),
    },
    existingPeople: [...existingIdentitySet(pkg.plan).names],
    targets: pkg.targets.map((target) => ({
      slot: String(target.group.ordinal || target.group.id),
      ordinal: target.group.ordinal || null,
      mode: target.rescueMode,
      existingName: text(target.snapshot?.values?.name),
      existingLinkedin: text(target.snapshot?.values?.linkedin),
      missingFields: target.snapshot?.missingFields || [],
    })),
    candidates: pkg.candidates.map(compactCandidate),
  }));

  // PASS 2: one batch selection call for all unresolved slots.
  const selectionResult = await batchChat([
    {
      role: 'system',
      content: [
        'You are ULTRON Batch POC Selector.',
        'Handle unresolved workplace POC targets for ALL supplied rows.',
        'You may choose ONLY candidateKey values supplied inside that same row.',
        'Each target has mode=fill or mode=repair.',
        'For mode=fill: never select the anchor or any person already listed in existingPeople.',
        'For mode=repair: select a candidate ONLY when it is the same real person as existingName/existingLinkedin; otherwise abstain for that target.',
        'Prefer people who can realistically influence or own hiring for fill targets.',
        'Use company size cues, recruiting/HR responsibility, functional relevance and seniority together; do not blindly follow prestige.',
        'A recruiter owning the vacancy may beat a distant executive; a founder/director may be right for a smaller company.',
        'Assign unique people to unique slots.',
        'Return strict JSON only: {"rows":[{"rowNumber":2,"assignments":[{"slot":"2","candidateKey":"...","confidence":0.0,"reason":""}]}]}.',
      ].join(' '),
    },
    { role: 'user', content: JSON.stringify({ rows: selectionInput }) },
  ], 'selection', stats, options);

  let assignments = validateAssignments(parseJson(resultText(selectionResult)) || {}, rowPackages);
  stats.aiSelectionsProposed = [...assignments.values()].reduce((sum, list) => sum + list.length, 0);

  // PASS 3: reviewer only when selection is incomplete/weak and budget allows it.
  if (stats.modelCalls < stats.maxCalls && reviewerNeeded(assignments, rowPackages)) {
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
        mode: target.rescueMode,
        existingName: text(target.snapshot?.values?.name),
        existingLinkedin: text(target.snapshot?.values?.linkedin),
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
          'For repair targets, preserve identity: choose only the candidate that is genuinely the same existing person.',
          'For fill targets, do not reuse an existing row identity.',
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
      const repairMode = assignment.target.rescueMode === 'repair';
      if (repairMode) {
        if (!planner.samePerson(assignment.target.snapshot?.values || {}, person)) {
          stats.aiSelectionRejects++;
          continue;
        }
      } else if ((nameKey && existing.names.has(nameKey)) || (linkedinKey && existing.linkedins.has(linkedinKey))) {
        stats.identityDuplicatesSkipped++;
        stats.aiSelectionRejects++;
        continue;
      }

      const writePlan = planner.safeWritesForGroup(pkg.row, assignment.target.group, person);
      if (!writePlan.allowed || !writePlan.writes.length) {
        stats.aiSelectionRejects++;
        continue;
      }

      base.queuePendingPhone(
        { pendingPhoneQueue },
        rowNumber,
        assignment.target.group,
        assignment.target.snapshot,
        person,
      );

      const byColumn = new Map();
      for (const write of writePlan.writes) if (!byColumn.has(write.columnIndex)) byColumn.set(write.columnIndex, write);
      const changes = [...byColumn.values()].map((write) => ({
        range: sheets.cellRange(source.sheetName, rowNumber, write.columnIndex),
        value: write.value,
      }));
      if (!changes.length) continue;

      await sheets.writeCells(source.spreadsheetId, changes);
      changedRows.add(rowNumber);
      stats.cellsChanged += changes.length;
      stats.newPeopleSelected++;
      stats.aiSelectionsAccepted++;
      stats.embeddedDesignationWrites += writePlan.writes.filter((write) => write.embeddedRole).length;
      stats.selectionAudit.push({
        rowNumber,
        groupId: assignment.target.group.id,
        slot: assignment.target.group.ordinal || null,
        mode: assignment.target.rescueMode,
        candidateKey: assignment.candidateKey,
        name: text(person.name),
        title: text(person.title),
        confidence: assignment.confidence,
        reason: assignment.reason,
        fields: writePlan.writes.map((write) => write.field),
      });
      claimed.add(assignment.candidateKey);
      if (nameKey) existing.names.add(nameKey);
      if (linkedinKey) existing.linkedins.add(linkedinKey);
    }

    const acceptedForRow = stats.selectionAudit.filter((item) => item.rowNumber === rowNumber).length;
    stats.unresolvedSlots += Math.max(0, pkg.targets.length - acceptedForRow);
  }

  stats.rowsChanged = changedRows.size;

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
  exactRepairCandidate,
  candidatePoolForTargets,
  validateAssignments,
  reviewerNeeded,
  run,
};
