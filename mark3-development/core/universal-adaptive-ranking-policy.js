'use strict';

// Population-adaptive, model-free ranking policy for universal enrichment.
// The base ranker extracts evidence dimensions; this layer calibrates them against
// the candidate population while preserving ULTRON's canonical company-contact
// priority lanes. Context and evidence break ties inside/below those lanes.

const base = require('./universal-authority-ranker');

const INSTALL_FLAG = Symbol.for('ultron.mark3.universalAdaptiveRanking.installed');

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function percentile(value, values = []) {
  const finite = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!finite.length) return 0;
  if (finite.length === 1) return finite[0] > 0 ? 1 : 0;
  let below = 0;
  let equal = 0;
  for (const item of finite) {
    if (item < value) below++;
    else if (item === value) equal++;
  }
  return clamp((below + equal * 0.5) / finite.length);
}

function contextRichness(context = {}) {
  const tokens = base.tokenList([
    context.details,
    context.postDetails,
    context.jobDescription,
    context.requirement,
    context.roleContext,
    context.targetFunction,
    context.targetRole,
  ].filter(Boolean).join(' '));
  return clamp(new Set(tokens).size / 24);
}

function structuredCoverage(candidates = []) {
  if (!candidates.length) return 0;
  const usable = candidates.filter((candidate) =>
    String(candidate?.seniority || '').trim()
    || (Array.isArray(candidate?.functions) && candidate.functions.length)
    || (Array.isArray(candidate?.departments) && candidate.departments.length)
  ).length;
  return usable / candidates.length;
}

function companyContactPriority(candidate = {}) {
  const value = base.normalize([candidate.title, candidate.headline].filter(Boolean).join(' '));
  if (!value) return 99;

  // Canonical company-lead preference used by ULTRON:
  // Founder/Director/Owner > recruiting/HR head or manager > recruiter/TA.
  if (/\b(?:founder|co founder|owner|managing director|executive director|director)\b/.test(value)) return 1;

  const exactManager = value === 'manager';
  if (
    /\b(?:head recruiter|lead recruiter|recruitment head|head of recruitment|recruitment lead|recruiting lead|head of talent acquisition|talent acquisition head|talent acquisition lead|head of hr|head of people|recruitment manager|recruiting manager|hiring manager|talent acquisition manager|hr manager|human resources manager|general manager)\b/.test(value)
    || exactManager
  ) return 2;

  if (/\b(?:hr recruiter|human resources recruiter|technical recruiter|talent acquisition recruiter|recruiter|talent acquisition specialist|talent acquisition partner|recruitment specialist)\b/.test(value)) return 3;
  return 99;
}

function prioritySignal(priority) {
  if (priority === 1) return 1;
  if (priority === 2) return 0.78;
  if (priority === 3) return 0.58;
  return 0;
}

function adaptiveWeights(context = {}, candidates = []) {
  const contextSignal = contextRichness(context);
  const structuredSignal = structuredCoverage(candidates);
  const sizeKnown = base.companyScale(context) > 0 ? 1 : 0;

  // Weight evidence according to availability, not according to a fixed title
  // hierarchy. Rich vacancy context raises functional ownership; sparse context
  // raises hiring-function evidence. Structured Apollo metadata raises authority
  // reliability. Identity remains primarily a safety dimension.
  const weights = {
    roleOwnership: 0.20 + contextSignal * 0.22,
    hiringAuthority: 0.31 - contextSignal * 0.13,
    authority: 0.14 + structuredSignal * 0.07,
    contextRelevance: 0.07 + contextSignal * 0.08,
    evidenceBreadth: 0.10,
    relativeDominance: 0.12,
    identity: 0.06,
    scale: sizeKnown ? 0.06 : 0,
    companyContactPriority: 0.18,
  };
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0) || 1;
  for (const key of Object.keys(weights)) weights[key] /= total;
  return { weights, contextSignal, structuredSignal, sizeKnown: Boolean(sizeKnown) };
}

function pairwiseDominance(index, rows, dimensions) {
  const current = rows[index];
  if (!current || rows.length <= 1) return 0.5;
  let wins = 0;
  let comparisons = 0;
  for (let j = 0; j < rows.length; j++) {
    if (j === index) continue;
    const other = rows[j];
    let localWins = 0;
    let localLosses = 0;
    for (const dimension of dimensions) {
      const a = Number(current.components?.[dimension] || 0);
      const b = Number(other.components?.[dimension] || 0);
      const delta = a - b;
      if (delta > 0.075) localWins++;
      else if (delta < -0.075) localLosses++;
    }
    if (localWins === localLosses) wins += 0.5;
    else if (localWins > localLosses) wins += 1;
    comparisons++;
  }
  return comparisons ? wins / comparisons : 0.5;
}

function adaptiveScoreRows(candidates = [], context = {}) {
  const unique = [];
  const seen = new Set();
  for (const candidate of candidates || []) {
    const key = String(candidate?.apolloPersonId || candidate?.id || base.linkedinKey(candidate?.linkedinUrl || candidate?.linkedin_url) || `${base.normalize(candidate?.name)}|${base.normalize(candidate?.title)}`);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }

  const baseRows = unique.map((candidate) => base.scoreCandidate(candidate, context, unique));
  const calibration = adaptiveWeights(context, unique);
  const dimensions = ['hiringAuthority', 'roleOwnership', 'authority', 'contextRelevance', 'evidenceBreadth'];
  const populations = Object.fromEntries(dimensions.map((dimension) => [dimension, baseRows.map((row) => Number(row.components?.[dimension] || 0))]));

  return baseRows.map((row, index) => {
    const c = row.components || {};
    const percentiles = Object.fromEntries(dimensions.map((dimension) => [dimension, percentile(Number(c[dimension] || 0), populations[dimension])]));
    const dominance = pairwiseDominance(index, baseRows, dimensions);
    const identity = clamp(c.identity);
    const conflict = clamp(c.conflictPenalty);
    const scale = Math.max(-1, Math.min(1, Number(c.scaleAdjustment || 0)));
    const contactPriority = companyContactPriority(row.candidate);
    const contactPrioritySignal = prioritySignal(contactPriority);

    const w = calibration.weights;
    const evidence =
      percentiles.roleOwnership * w.roleOwnership
      + percentiles.hiringAuthority * w.hiringAuthority
      + percentiles.authority * w.authority
      + percentiles.contextRelevance * w.contextRelevance
      + clamp(c.evidenceBreadth) * w.evidenceBreadth
      + dominance * w.relativeDominance
      + identity * w.identity
      + Math.max(0, scale) * w.scale
      + contactPrioritySignal * w.companyContactPriority;

    const penalty = conflict + Math.max(0, -scale) * 0.45;
    const score = clamp(evidence - penalty) * 100;
    const usefulEvidence = Math.max(
      Number(c.hiringAuthority || 0),
      Number(c.roleOwnership || 0),
      Number(c.contextRelevance || 0),
      Number(c.authority || 0),
    );
    // A candidate in the explicit company-contact priority lanes is valid evidence
    // even when Apollo omits structured function/department metadata.
    const eligible = conflict < 0.9 && identity >= 0.25 && (contactPriority < 99 || usefulEvidence >= 0.12);

    return {
      ...row,
      score: Number(score.toFixed(2)),
      eligible,
      contactPriority,
      components: {
        ...c,
        companyContactPriority: contactPriority < 99 ? contactPriority : null,
        companyContactPrioritySignal: Number(contactPrioritySignal.toFixed(3)),
      },
      adaptive: {
        ...calibration,
        percentiles,
        pairwiseDominance: Number(dominance.toFixed(3)),
      },
      proof: [...new Set([...(row.proof || []), `adaptive-context:${calibration.contextSignal.toFixed(2)}`, `adaptive-structured:${calibration.structuredSignal.toFixed(2)}`])],
    };
  });
}

function confidenceFor(rows, index) {
  const current = rows[index];
  if (!current) return 0;
  const next = rows[index + 1];
  const margin = next ? Math.max(0, current.score - next.score) : Math.max(0, current.score - 45);
  const breadth = Number(current.components?.evidenceBreadth || 0);
  const identity = Number(current.components?.identity || 0);
  const dominance = Number(current.adaptive?.pairwiseDominance || 0);
  return clamp(0.28 + current.score / 220 + Math.min(0.2, margin / 85) + breadth * 0.1 + identity * 0.07 + dominance * 0.08);
}

function rankCandidates(candidates = [], context = {}, options = {}) {
  const scored = adaptiveScoreRows(candidates, context);
  const eligible = scored.filter((row) => row.eligible).sort((a, b) => {
    const ap = Number(a.contactPriority || 99);
    const bp = Number(b.contactPriority || 99);
    const aTiered = ap < 99;
    const bTiered = bp < 99;
    if (aTiered !== bTiered) return aTiered ? -1 : 1;
    if (aTiered && ap !== bp) return ap - bp;
    return b.score - a.score || String(a.candidate?.name || '').localeCompare(String(b.candidate?.name || ''));
  });

  // Keep a quality floor for unclassified functional candidates, but do not throw
  // away explicit Founder/Director, HR-manager or recruiter lanes merely because
  // Apollo's sparse search payload omitted structured metadata.
  const requested = Number(options.minimumScore);
  const median = eligible.length ? [...eligible.map((row) => row.score)].sort((a, b) => a - b)[Math.floor(eligible.length / 2)] : 0;
  const threshold = Number.isFinite(requested) ? requested : Math.max(30, Math.min(48, median * 0.78));
  const rankedPool = eligible.filter((row) => row.contactPriority < 99 || row.score >= threshold);
  const ranked = rankedPool
    .map((row, index, rows) => {
      const priorityBoost = row.contactPriority === 1 ? 0.14 : row.contactPriority === 2 ? 0.11 : row.contactPriority === 3 ? 0.08 : 0;
      return {
        ...row,
        confidence: Number(clamp(confidenceFor(rows, index) + priorityBoost).toFixed(3)),
        rank: index + 1,
      };
    });

  return {
    ranked,
    rejected: scored.filter((row) => !row.eligible || (row.contactPriority >= 99 && row.score < threshold)),
    total: scored.length,
    eligible: ranked.length,
    threshold: Number(threshold.toFixed(2)),
    deterministic: true,
    adaptive: true,
    modelCalls: 0,
  };
}

function selectCandidates(candidates = [], context = {}, count = 1, options = {}) {
  const ranked = rankCandidates(candidates, context, options);
  const wanted = Math.max(0, Math.floor(Number(count || 0)));
  const minimumConfidence = Number.isFinite(Number(options.minimumConfidence)) ? Number(options.minimumConfidence) : 0.54;
  const selected = ranked.ranked.filter((row) => row.confidence >= minimumConfidence).slice(0, wanted);
  return { ...ranked, selected, requested: wanted, shortfall: Math.max(0, wanted - selected.length) };
}

function install() {
  if (globalThis[INSTALL_FLAG]) return globalThis[INSTALL_FLAG];
  base.rankCandidates = rankCandidates;
  base.selectCandidates = selectCandidates;
  base.adaptiveScoreRows = adaptiveScoreRows;
  base.adaptiveWeights = adaptiveWeights;
  const api = Object.freeze({ rankCandidates, selectCandidates, adaptiveScoreRows, adaptiveWeights, percentile, contextRichness, structuredCoverage, companyContactPriority, prioritySignal });
  globalThis[INSTALL_FLAG] = api;
  return api;
}

module.exports = { install, rankCandidates, selectCandidates, adaptiveScoreRows, adaptiveWeights, percentile, contextRichness, structuredCoverage, companyContactPriority, prioritySignal };
