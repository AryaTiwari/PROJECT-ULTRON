const fs = require('fs');
const path = require('path');
const config = require('./config');
const memory = require('./memory');
const workspace = require('./workspace');
const { writeJsonAtomic, readJson } = require('./persistence');
const { emit } = require('./events');

const ROOT = path.resolve(config.projectRoot, '.ultron', 'adaptive');
const PROFILE_PATH = path.join(ROOT, 'profile.json');
const EVENTS_PATH = path.join(ROOT, 'observations.jsonl');
const PROPOSALS_PATH = path.join(ROOT, 'proposals.json');
const MAX_SIGNALS_PER_DOMAIN = 60;

function ensureRoot() { fs.mkdirSync(ROOT, { recursive: true }); }
function defaultProfile() {
  return {
    version: 1,
    updatedAt: null,
    totalObservations: 0,
    domains: {},
    policy: {
      inferSensitiveTraits: false,
      explicitFeedbackFirst: true,
      externalActionsRequireApproval: true,
      silentAutonomyAllowed: ['local-analysis', 'local-planning', 'local-file-organization', 'research'],
    },
  };
}
function loadProfile() { ensureRoot(); return readJson(PROFILE_PATH, defaultProfile()); }
function saveProfile(profile) { ensureRoot(); profile.updatedAt = new Date().toISOString(); writeJsonAtomic(PROFILE_PATH, profile); return profile; }
function appendObservation(row) {
  ensureRoot();
  fs.appendFileSync(EVENTS_PATH, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`, 'utf8');
}
function loadProposals() { ensureRoot(); return readJson(PROPOSALS_PATH, { version: 1, items: [] }); }
function saveProposals(data) { ensureRoot(); writeJsonAtomic(PROPOSALS_PATH, data); return data; }

function domainFor(text = '') {
  const value = String(text || '').toLowerCase();
  if (/\b(?:reel|reels|instagram|creator|content|caption|hook|b-roll|broll|short-form|short form|video edit|social media)\b/.test(value)) return 'creator-content';
  if (/\b(?:ui|ux|design|font|typography|layout|aesthetic|color|visual|dashboard|website style)\b/.test(value)) return 'design';
  if (/\b(?:code|coding|github|repo|repository|bug|developer|software|api|architecture)\b/.test(value)) return 'development';
  if (/\b(?:elevate os|business|client|lead|sales|pricing|revenue|founder|strategy|marketplace|outreach)\b/.test(value)) return 'business';
  if (/\b(?:voice|tone|reply|answer|message|email|write|wording|short|long|detailed|concise)\b/.test(value)) return 'communication';
  if (/\b(?:research|source|trend|hootsuite|market|compare|evidence)\b/.test(value)) return 'research';
  return 'general';
}

function normalizeSignalText(text = '') {
  return String(text || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 420);
}

function feedbackPolarity(text = '') {
  const value = String(text || '').toLowerCase();
  const negative = /\b(?:don'?t like|do not like|hate|bad|ugly|unfinished|too much|too many|overloaded|unorganised|unorganized|not good|not clean|avoid|stop using|never use|less of|remove|wrong|worse)\b/.test(value);
  const positive = /\b(?:i like|i love|i prefer|this is good|looks good|better|keep this|use this|more like this|exactly|perfect|works well|i want|always use)\b/.test(value);
  if (negative && !positive) return -1;
  if (positive && !negative) return 1;
  if (negative && positive) return 0;
  return null;
}

function isExplicitPreference(text = '') {
  return /\b(?:i want|i prefer|i like|i love|i don'?t like|do not like|never|always|keep|avoid|stop using|use this|too much|too many|less|more|make it|should be|shouldn'?t|not like this|instead)\b/i.test(String(text || ''));
}

function extractPreference(text = '') {
  const cleaned = normalizeSignalText(text);
  if (!cleaned || !isExplicitPreference(cleaned)) return null;
  const polarity = feedbackPolarity(cleaned);
  const domain = domainFor(cleaned);
  return {
    domain,
    text: cleaned,
    polarity: polarity === null ? 0 : polarity,
    explicit: true,
    confidence: 0.86,
  };
}

function signalKey(signal) {
  const base = String(signal?.text || '').toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(?:i|want|like|love|prefer|please|this|that|the|a|an|it|is|are|was|were|to|of|for|my)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);
  return base || `signal-${Date.now()}`;
}

function rememberPreference(signal) {
  if (!signal?.text) return null;
  try {
    return memory.remember({
      type: 'preference',
      key: `adaptive:${signal.domain}:${signalKey(signal)}`,
      entity: `User preference — ${signal.domain}`,
      relation: signal.polarity < 0 ? 'avoid/prefer less' : signal.polarity > 0 ? 'prefer/use more' : 'preference',
      content: `Adaptive preference in ${signal.domain}: ${signal.text}`,
      importance: signal.explicit ? 0.88 : 0.68,
      confidence: signal.confidence || 0.75,
      source: 'adaptive-intelligence',
      tags: ['adaptive', 'preference', signal.domain, signal.polarity < 0 ? 'negative-feedback' : signal.polarity > 0 ? 'positive-feedback' : 'feedback'],
    });
  } catch {
    return null;
  }
}

function recordSignal(signal, meta = {}) {
  if (!signal?.text) return null;
  const profile = loadProfile();
  const domain = signal.domain || 'general';
  const bucket = profile.domains[domain] || { observations: 0, signals: [], lastUpdatedAt: null };
  const key = signalKey(signal);
  const existing = bucket.signals.find((item) => item.key === key);
  if (existing) {
    existing.hits = Number(existing.hits || 1) + 1;
    existing.score = Math.max(-8, Math.min(8, Number(existing.score || 0) + (signal.polarity || 0)));
    existing.confidence = Math.min(0.99, Math.max(Number(existing.confidence || 0.5), Number(signal.confidence || 0.75)) + 0.02);
    existing.lastSeenAt = new Date().toISOString();
    existing.latestText = signal.text;
  } else {
    bucket.signals.unshift({
      key,
      text: signal.text,
      latestText: signal.text,
      score: signal.polarity || 0,
      hits: 1,
      confidence: signal.confidence || 0.75,
      explicit: Boolean(signal.explicit),
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    });
  }
  bucket.observations = Number(bucket.observations || 0) + 1;
  bucket.lastUpdatedAt = new Date().toISOString();
  bucket.signals = bucket.signals
    .sort((a, b) => (b.hits * b.confidence + Math.abs(b.score)) - (a.hits * a.confidence + Math.abs(a.score)))
    .slice(0, MAX_SIGNALS_PER_DOMAIN);
  profile.domains[domain] = bucket;
  profile.totalObservations = Number(profile.totalObservations || 0) + 1;
  saveProfile(profile);
  appendObservation({ kind: 'preference-signal', signal: { ...signal, key }, meta: { source: meta.source || 'conversation', taskType: meta.taskType || null } });
  rememberPreference(signal);
  emit('adaptive_signal_recorded', { domain, key, polarity: signal.polarity || 0, confidence: signal.confidence || 0.75 });
  return { domain, key };
}

function approvalIntent(text = '') {
  const value = String(text || '').trim().toLowerCase();
  if (/^(?:yes|yep|yeah|approve|approved|do it|go ahead|proceed|execute|ship it|post it|send it|continue|okay do it|ok do it)[.! ]*$/.test(value)) return 'approve';
  if (/^(?:no|nope|reject|don'?t|do not|stop|cancel|not this|skip it)[.! ]*$/.test(value)) return 'reject';
  return null;
}

function observeTurn(userMessage, assistantResponse = '', meta = {}) {
  const signal = extractPreference(userMessage);
  if (signal) recordSignal(signal, meta);
  appendObservation({
    kind: 'turn',
    domain: domainFor(userMessage),
    user: normalizeSignalText(userMessage),
    assistant: normalizeSignalText(assistantResponse).slice(0, 600),
    approvalIntent: approvalIntent(userMessage),
    meta: { taskType: meta.taskType || null, mode: meta.mode || null },
  });
  const decision = approvalIntent(userMessage);
  if (decision) resolveLatestProposal(decision, { userMessage });
  return { signal, decision };
}

function topSignals(domain = null, limit = 8) {
  const profile = loadProfile();
  const domains = domain ? [[domain, profile.domains[domain]]] : Object.entries(profile.domains || {});
  const rows = [];
  for (const [name, bucket] of domains) {
    for (const signal of bucket?.signals || []) rows.push({ domain: name, ...signal });
  }
  return rows
    .sort((a, b) => (b.hits * b.confidence + Math.abs(b.score)) - (a.hits * a.confidence + Math.abs(a.score)))
    .slice(0, Math.max(1, limit));
}

function contextFor(domain = null, limit = 6) {
  const signals = topSignals(domain, limit);
  if (!signals.length) return { available: false, domain, preferences: [], summary: '' };
  const preferences = signals.map((item) => ({
    domain: item.domain,
    preference: item.latestText || item.text,
    direction: item.score < 0 ? 'avoid/less' : item.score > 0 ? 'prefer/more' : 'context',
    confidence: Number(item.confidence || 0.5),
    hits: Number(item.hits || 1),
  }));
  const summary = preferences.map((item) => `${item.direction}: ${item.preference}`).join(' | ').slice(0, 1600);
  return { available: true, domain, preferences, summary };
}

function proposeAction(proposal = {}) {
  if (!proposal?.title || !proposal?.action) throw new Error('Adaptive proposal needs title and action.');
  const data = loadProposals();
  const item = {
    id: `adaptive-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title: String(proposal.title).slice(0, 140),
    rationale: String(proposal.rationale || '').slice(0, 900),
    action: String(proposal.action).slice(0, 1200),
    domain: proposal.domain || domainFor(`${proposal.title} ${proposal.action}`),
    externalSideEffect: proposal.externalSideEffect !== false,
    requiresApproval: proposal.requiresApproval !== false,
    status: 'pending_approval',
    createdAt: new Date().toISOString(),
    decidedAt: null,
  };
  data.items = [item, ...(data.items || [])].slice(0, 100);
  saveProposals(data);
  emit('adaptive_proposal_created', item);
  return item;
}

function pendingProposals() { return (loadProposals().items || []).filter((item) => item.status === 'pending_approval'); }
function resolveLatestProposal(decision, meta = {}) {
  const data = loadProposals();
  const item = (data.items || []).find((row) => row.status === 'pending_approval');
  if (!item) return null;
  item.status = decision === 'approve' ? 'approved' : 'rejected';
  item.decidedAt = new Date().toISOString();
  item.decisionSource = meta.userMessage ? 'conversation' : 'system';
  saveProposals(data);
  appendObservation({ kind: 'proposal-decision', proposalId: item.id, decision: item.status, domain: item.domain });
  recordSignal({
    domain: item.domain || 'general',
    text: `${item.status === 'approved' ? 'Approved' : 'Rejected'} adaptive action: ${item.title}`,
    polarity: item.status === 'approved' ? 1 : -1,
    explicit: false,
    confidence: 0.72,
  }, { source: 'proposal-decision' });
  return item;
}

function dailySuggestion() {
  const signals = topSignals(null, 6);
  if (signals.length < 2) return null;
  const state = workspace.stateSnapshot();
  const strongest = signals[0];
  const topAction = state?.topAction?.title || null;
  return {
    title: `Adaptive suggestion — ${strongest.domain}`,
    rationale: `Repeated preference signal (${strongest.hits} observation${strongest.hits === 1 ? '' : 's'}): ${strongest.latestText || strongest.text}`,
    action: topAction
      ? `Apply the learned ${strongest.domain} preference while working on the current priority: ${topAction}.`
      : `Apply the learned ${strongest.domain} preference to the next relevant task instead of using generic defaults.`,
    domain: strongest.domain,
    externalSideEffect: false,
    requiresApproval: true,
  };
}

function maybeEmitDailySuggestion() {
  const profile = loadProfile();
  const today = new Date().toISOString().slice(0, 10);
  if (profile.lastSuggestionDay === today) return null;
  const suggestion = dailySuggestion();
  if (!suggestion) return null;
  profile.lastSuggestionDay = today;
  saveProfile(profile);
  const proposal = proposeAction(suggestion);
  emit('proactive_alert', {
    priority: 1,
    reason: 'adaptive_pattern_suggestion',
    summary: `${proposal.title}: ${proposal.action} Approval required before treating this as an action commitment.`,
    proposal,
  });
  return proposal;
}

function status() {
  const profile = loadProfile();
  const pending = pendingProposals();
  return {
    enabled: true,
    root: ROOT,
    totalObservations: profile.totalObservations || 0,
    domains: Object.fromEntries(Object.entries(profile.domains || {}).map(([key, value]) => [key, { observations: value.observations || 0, signals: (value.signals || []).length }])),
    pendingApprovals: pending.length,
    policy: profile.policy,
  };
}

module.exports = {
  ROOT,
  PROFILE_PATH,
  EVENTS_PATH,
  PROPOSALS_PATH,
  domainFor,
  feedbackPolarity,
  isExplicitPreference,
  extractPreference,
  approvalIntent,
  observeTurn,
  recordSignal,
  topSignals,
  contextFor,
  proposeAction,
  pendingProposals,
  resolveLatestProposal,
  dailySuggestion,
  maybeEmitDailySuggestion,
  status,
};
