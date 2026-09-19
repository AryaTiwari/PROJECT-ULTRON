'use strict';

const companyIdentity = require('./company-identity');

// Universal deterministic authority/routing ranker.
// It deliberately does NOT contain a Founder > Manager > Recruiter title ladder.
// Candidates are scored from independent evidence dimensions so unfamiliar titles can
// still rank correctly when their function, authority and row-context evidence is strong.

const LEGAL_SUFFIXES = new Set([
  'pvt','private','ltd','limited','llp','plc','inc','incorporated','corp','corporation','company','co','llc','gmbh','sa','ag','bv','pte','holdings','group',
]);
const STOPWORDS = new Set([
  'a','an','the','and','or','for','of','to','in','on','at','by','with','from','is','are','be','as','this','that','we','our','you','your',
  'job','role','opening','openings','vacancy','vacancies','position','positions','hiring','hire','looking','required','requirement','requirements',
  'experience','years','year','work','working','candidate','candidates','apply','immediate','joiner','joiners','remote','hybrid','onsite','full','time',
]);

function normalize(value) {
  return String(value || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9+#]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenList(value) {
  return normalize(value).split(' ').filter((token) => token && !STOPWORDS.has(token));
}

function companyKey(value) {
  return companyIdentity.companyKey(value);
}

function hostname(value) {
  return companyIdentity.hostname(value);
}

function linkedinKey(value) {
  const raw = String(value || '').trim().toLowerCase();
  const match = raw.match(/linkedin\.com\/in\/([^/?#]+)/i);
  return match?.[1]?.replace(/\/+$/, '') || '';
}

function candidateCompany(candidate = {}) {
  return String(
    candidate.organizationName
    || candidate.organization_name
    || candidate.organization?.name
    || candidate.employment_history?.find?.((item) => item?.current)?.organization_name
    || ''
  ).trim();
}

function candidateDomain(candidate = {}) {
  return hostname(
    candidate.organizationDomain
    || candidate.organization?.website_url
    || candidate.organization?.primary_domain
    || candidate.organization?.domain
    || ''
  );
}

function domainBrand(value) {
  return companyIdentity.domainBrand(value);
}

function companyTokenMatch(expectedValue, actualValue) {
  return companyIdentity.nameMatch(expectedValue, actualValue);
}

function sameEmployer(candidate, context = {}) {
  const expectedDomain = hostname(context.companyDomain || context.domain || '');
  const expectedCompany = context.company || context.companyName || '';
  const aliases = Array.isArray(context.companyAliases) ? context.companyAliases : [];
  const actualCompany = candidateCompany(candidate);
  const actualDomain = candidateDomain(candidate);

  if (!expectedCompany && !expectedDomain && !aliases.length) return true;

  return companyIdentity.sameOrganization({
    expectedCompany,
    expectedDomain,
    actualCompany,
    actualDomain,
    aliases,
  });
}

function stem(token) {
  const value = normalize(token);
  if (value.length <= 4) return value;
  return value.replace(/(?:ations?|ments?|ness|ers?|ing|ed|ies|s)$/i, '').slice(0, 18);
}

function stems(values) {
  const list = Array.isArray(values) ? values.flatMap(tokenList) : tokenList(values);
  return new Set(list.map(stem).filter(Boolean));
}

function hasStem(set, prefixes) {
  for (const value of set) {
    if (prefixes.some((prefix) => value === prefix || value.startsWith(prefix))) return true;
  }
  return false;
}

const HIRING_STEMS = Object.freeze(['recruit','talent','acquis','sourc','staff','hir','resourc','people','workforc']);
const AUTHORITY_STEMS = Object.freeze(['chief','head','director','vice','president','manager','lead','leader','partner','owner','founder','principal','executive']);
const PEOPLE_STEMS = Object.freeze(['human','hr','people','talent','recruit','staff','workforc','personnel']);
const JUNIOR_STEMS = Object.freeze(['intern','trainee','assistant','associate','junior','apprentice','student']);

function structuredSet(candidate, key) {
  const value = candidate?.[key];
  if (Array.isArray(value)) return stems(value);
  return stems(value || '');
}

function candidateTextSet(candidate = {}) {
  return stems([
    candidate.title,
    candidate.headline,
    ...(Array.isArray(candidate.departments) ? candidate.departments : []),
    ...(Array.isArray(candidate.functions) ? candidate.functions : []),
  ]);
}

function hiringFunctionEvidence(candidate = {}) {
  const title = stems([candidate.title, candidate.headline]);
  const departments = structuredSet(candidate, 'departments');
  const functions = structuredSet(candidate, 'functions');
  const combined = new Set([...title, ...departments, ...functions]);
  let score = 0;
  const proof = [];
  if (hasStem(functions, HIRING_STEMS)) { score += 0.42; proof.push('structured-function:hiring'); }
  if (hasStem(departments, PEOPLE_STEMS)) { score += 0.28; proof.push('structured-department:people'); }
  if (hasStem(title, HIRING_STEMS)) { score += 0.32; proof.push('title:hiring'); }
  if (hasStem(combined, PEOPLE_STEMS)) { score += 0.12; proof.push('people-function'); }
  return { value: Math.min(1, score), proof };
}

function authorityEvidence(candidate = {}) {
  const seniority = normalize(candidate.seniority || '');
  const text = stems([candidate.title, candidate.headline, seniority]);
  let value = 0;
  const proof = [];
  const structured = [
    [/owner|founder|c.?suite|chief/, 0.95],
    [/vice.?president|\bvp\b|head/, 0.82],
    [/director|principal/, 0.72],
    [/manager|lead|partner/, 0.6],
    [/senior/, 0.42],
    [/entry|intern|trainee/, 0.08],
  ];
  for (const [pattern, score] of structured) {
    if (pattern.test(seniority)) { value = Math.max(value, score); proof.push(`seniority:${seniority}`); }
  }
  if (hasStem(text, AUTHORITY_STEMS)) value = Math.max(value, 0.55);
  if (hasStem(text, ['chief','owner','founder'])) value = Math.max(value, 0.92);
  if (hasStem(text, ['head','vice','president'])) value = Math.max(value, 0.8);
  if (hasStem(text, ['director','principal'])) value = Math.max(value, 0.7);
  if (hasStem(text, ['manager','lead','partner'])) value = Math.max(value, 0.58);
  if (hasStem(text, JUNIOR_STEMS)) value *= 0.42;
  if (value > 0 && !proof.length) proof.push('title:authority');
  return { value: Math.max(0, Math.min(1, value)), proof };
}

function contextTerms(context = {}) {
  return stems([
    context.details,
    context.postDetails,
    context.jobDescription,
    context.requirement,
    context.roleContext,
    context.targetFunction,
    context.targetRole,
  ]);
}

function documentFrequency(candidates = []) {
  const counts = new Map();
  for (const candidate of candidates) {
    const set = candidateTextSet(candidate);
    for (const token of set) counts.set(token, (counts.get(token) || 0) + 1);
  }
  return counts;
}

function contextualRelevance(candidate, context, candidates) {
  const target = contextTerms(context);
  if (!target.size) return { value: 0, proof: [], matched: [] };
  const candidateTerms = candidateTextSet(candidate);
  const df = documentFrequency(candidates);
  let matchedWeight = 0;
  let targetWeight = 0;
  const matched = [];
  const n = Math.max(1, candidates.length);
  for (const token of target) {
    const weight = Math.log(1 + n / (1 + (df.get(token) || 0)));
    targetWeight += weight;
    if (candidateTerms.has(token)) { matchedWeight += weight; matched.push(token); }
  }
  const value = targetWeight ? matchedWeight / targetWeight : 0;
  return { value: Math.min(1, value), proof: matched.length ? [`context-match:${matched.slice(0, 8).join(',')}`] : [], matched };
}

function identityEvidence(candidate = {}) {
  const id = String(candidate.apolloPersonId || candidate.id || '').trim();
  const linkedin = linkedinKey(candidate.linkedinUrl || candidate.linkedin_url || candidate.linkedin || '');
  const name = normalize(candidate.name || [candidate.first_name, candidate.last_name].filter(Boolean).join(' '));
  const title = normalize(candidate.title || '');
  let value = 0;
  const proof = [];
  if (id) { value += 0.3; proof.push('apollo-id'); }
  if (linkedin) { value += 0.3; proof.push('personal-linkedin'); }
  if (name && !/\*{2,}/.test(name)) { value += 0.2; proof.push('full-name'); }
  if (title) { value += 0.2; proof.push('title'); }
  if (candidate.identityVerified === false) value *= 0.3;
  return { value: Math.min(1, value), proof };
}

function companyScale(context = {}) {
  const direct = Number(context.companyHeadcount || context.employeeCount || context.headcount || 0);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const min = Number(context.companyHeadcountMin || 0);
  const max = Number(context.companyHeadcountMax || 0);
  if (min > 0 && max > 0) return (min + max) / 2;
  if (max > 0) return max * 0.7;
  if (min > 0) return min * 1.3;
  return 0;
}

function scaleAdjustment(candidate, context, hiring, authority) {
  const size = companyScale(context);
  if (!size) return { value: 0, proof: [] };
  const candidateTerms = candidateTextSet(candidate);
  const generalLeadership = hasStem(candidateTerms, ['owner','founder','chief','director','president']);
  let value = 0;
  const proof = [];
  if (size <= 50 && generalLeadership && hiring.value < 0.35) { value += 0.22; proof.push('small-company-general-leadership'); }
  if (size >= 250 && generalLeadership && hiring.value < 0.25) { value -= 0.22; proof.push('large-company-unspecialized-leadership'); }
  if (size >= 100 && hiring.value >= 0.45 && authority.value >= 0.45) { value += 0.14; proof.push('scaled-specialized-hiring-authority'); }
  return { value, proof };
}

function conflictPenalty(candidate, context, candidates) {
  let penalty = 0;
  const proof = [];
  if (!sameEmployer(candidate, context)) { penalty += 1; proof.push('employer-conflict'); }
  const candidateId = String(candidate.apolloPersonId || candidate.id || '').trim();
  const anchorId = String(context.anchorApolloPersonId || context.anchorId || '').trim();
  const candidateLinkedin = linkedinKey(candidate.linkedinUrl || candidate.linkedin_url || candidate.linkedin || '');
  const anchorLinkedin = linkedinKey(context.anchorLinkedin || context.anchorLinkedIn || '');
  if ((candidateId && anchorId && candidateId === anchorId) || (candidateLinkedin && anchorLinkedin && candidateLinkedin === anchorLinkedin)) {
    penalty += 1; proof.push('anchor-identity');
  }
  const text = candidateTextSet(candidate);
  if (hasStem(text, JUNIOR_STEMS) && !hasStem(text, HIRING_STEMS)) { penalty += 0.18; proof.push('junior-unrelated'); }
  if (!candidate.title && !(candidate.functions || []).length && !(candidate.departments || []).length) { penalty += 0.12; proof.push('weak-role-evidence'); }
  return { value: Math.min(1, penalty), proof };
}

function scoreCandidate(candidate, context = {}, candidates = []) {
  const hiring = hiringFunctionEvidence(candidate);
  const authority = authorityEvidence(candidate);
  const relevance = contextualRelevance(candidate, context, candidates);
  const identity = identityEvidence(candidate);
  const scale = scaleAdjustment(candidate, context, hiring, authority);
  const conflict = conflictPenalty(candidate, context, candidates);

  // Role ownership is distinct from HR/recruiting: a functional leader with strong
  // vacancy overlap can be the correct hiring authority even without recruiter words.
  const roleOwnership = Math.min(1, relevance.value * (0.45 + authority.value * 0.55));
  const hiringAuthority = Math.min(1, hiring.value * (0.55 + authority.value * 0.45));
  const evidenceBreadth = [hiring.value, authority.value, relevance.value, identity.value].filter((v) => v >= 0.25).length / 4;

  const raw =
    hiringAuthority * 34
    + roleOwnership * 29
    + authority.value * 15
    + identity.value * 12
    + evidenceBreadth * 10
    + scale.value * 100
    - conflict.value * 100;

  const score = Math.max(0, Math.min(100, raw));
  const proof = [
    ...hiring.proof,
    ...authority.proof,
    ...relevance.proof,
    ...identity.proof,
    ...scale.proof,
    ...conflict.proof,
  ];
  return {
    candidate,
    score: Number(score.toFixed(2)),
    eligible: conflict.value < 0.9 && identity.value >= 0.25 && (hiringAuthority >= 0.18 || roleOwnership >= 0.18 || (authority.value >= 0.75 && companyScale(context) > 0 && companyScale(context) <= 50)),
    components: {
      hiringFunction: Number(hiring.value.toFixed(3)),
      authority: Number(authority.value.toFixed(3)),
      contextRelevance: Number(relevance.value.toFixed(3)),
      roleOwnership: Number(roleOwnership.toFixed(3)),
      hiringAuthority: Number(hiringAuthority.toFixed(3)),
      identity: Number(identity.value.toFixed(3)),
      scaleAdjustment: Number(scale.value.toFixed(3)),
      conflictPenalty: Number(conflict.value.toFixed(3)),
      evidenceBreadth: Number(evidenceBreadth.toFixed(3)),
    },
    proof: [...new Set(proof)],
  };
}

function confidenceFor(ranked, index) {
  const current = ranked[index];
  if (!current) return 0;
  const next = ranked[index + 1];
  const margin = next ? Math.max(0, current.score - next.score) : Math.max(0, current.score - 45);
  const breadth = current.components.evidenceBreadth;
  const identity = current.components.identity;
  return Math.max(0, Math.min(1, 0.35 + current.score / 250 + Math.min(0.18, margin / 100) + breadth * 0.12 + identity * 0.08));
}

function rankCandidates(candidates = [], context = {}, options = {}) {
  const unique = [];
  const seen = new Set();
  for (const candidate of candidates || []) {
    const key = String(candidate?.apolloPersonId || candidate?.id || linkedinKey(candidate?.linkedinUrl || candidate?.linkedin_url) || `${normalize(candidate?.name)}|${normalize(candidate?.title)}`);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }
  const scored = unique.map((candidate) => scoreCandidate(candidate, context, unique));
  const eligible = scored.filter((item) => item.eligible).sort((a, b) => b.score - a.score || String(a.candidate.name || '').localeCompare(String(b.candidate.name || '')));
  const threshold = Number.isFinite(Number(options.minimumScore)) ? Number(options.minimumScore) : 38;
  const ranked = eligible.filter((item) => item.score >= threshold).map((item, index, arr) => ({ ...item, confidence: Number(confidenceFor(arr, index).toFixed(3)), rank: index + 1 }));
  return {
    ranked,
    rejected: scored.filter((item) => !item.eligible || item.score < threshold),
    total: unique.length,
    eligible: ranked.length,
    deterministic: true,
  };
}

function selectCandidates(candidates = [], context = {}, count = 1, options = {}) {
  const ranked = rankCandidates(candidates, context, options);
  const wanted = Math.max(0, Math.floor(Number(count || 0)));
  const minimumConfidence = Number.isFinite(Number(options.minimumConfidence)) ? Number(options.minimumConfidence) : 0.56;
  const selected = ranked.ranked.filter((item) => item.confidence >= minimumConfidence).slice(0, wanted);
  return { ...ranked, selected, requested: wanted, shortfall: Math.max(0, wanted - selected.length) };
}

module.exports = {
  normalize,
  tokenList,
  companyKey,
  hostname,
  linkedinKey,
  sameEmployer,
  hiringFunctionEvidence,
  authorityEvidence,
  contextualRelevance,
  identityEvidence,
  companyScale,
  scoreCandidate,
  rankCandidates,
  selectCandidates,
};
