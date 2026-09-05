const assistant = require('./assistant');
const adaptive = require('./adaptive-intelligence');
const reelIntelligence = require('./reel-intelligence');
const instagramAesthetic = require('./instagram-aesthetic');
const reelLearning = require('./reel-learning');

let installed = false;
let originalHandle = null;
let timer = null;

function isLearningStatusRequest(text = '') {
  return /\b(?:what have you learned about me|what did you learn about me|adaptive (?:status|profile|learning)|how are you adapting|my learned preferences|what patterns have you learned)\b/i.test(String(text || ''));
}

function isReelIdeaRequest(text = '') {
  const value = String(text || '');
  return /\b(?:suggest|give|find|generate|recommend|what should i (?:post|make|create)|what can i (?:post|make|create))\b[\s\S]{0,90}\b(?:reel|reels|video ideas?|content ideas?|instagram content)\b/i.test(value)
    || /\b(?:reel|reels|instagram)\b[\s\S]{0,70}\b(?:ideas?|suggestions?|what should i post)\b/i.test(value);
}

function isTrendRefreshRequest(text = '') {
  return /\b(?:refresh|update|check|research|scan)\b[\s\S]{0,80}\b(?:hootsuite|reel trends?|instagram trends?|short-form trends?|content trends?)\b/i.test(String(text || ''));
}

function isInstagramAestheticRequest(text = '') {
  const value = String(text || '');
  return /\b(?:analy[sz]e|check|read|inspect|learn|understand|scan)\b[\s\S]{0,90}\b(?:my\s+)?instagram\b[\s\S]{0,70}\b(?:aesthetic|style|feed|profile|pfp|visuals?|look|branding)\b/i.test(value)
    || /\b(?:my\s+)?instagram\b[\s\S]{0,70}\b(?:aesthetic|style|feed|pfp|visuals?|look|branding)\b[\s\S]{0,50}\b(?:analy[sz]e|check|learn|understand)\b/i.test(value);
}

function proposalDecisionIntent(text = '') {
  const value = String(text || '').trim();
  if (/\b(?:reject|decline|skip|cancel|don'?t do|do not do)\b[\s\S]{0,45}\b(?:adaptive|suggestion|proposal|recommended action|recommendation)\b/i.test(value)
    || /\b(?:adaptive|suggestion|proposal|recommended action|recommendation)\b[\s\S]{0,45}\b(?:reject|decline|skip|cancel)\b/i.test(value)) return 'reject';
  if (/\b(?:approve|execute|do|proceed with|go ahead with)\b[\s\S]{0,45}\b(?:adaptive|suggestion|proposal|recommended action|recommendation)\b/i.test(value)
    || /\b(?:adaptive|suggestion|proposal|recommended action|recommendation)\b[\s\S]{0,45}\b(?:approve|execute|do it|proceed|go ahead)\b/i.test(value)) return 'approve';
  const pending = adaptive.pendingProposals();
  const latest = pending[0];
  const recent = latest?.createdAt && Date.now() - Date.parse(latest.createdAt) <= 15 * 60 * 1000;
  if (recent && /^(?:approve|approved|yes,? do it|yes do it|go ahead|proceed)$/i.test(value)) return 'approve';
  if (recent && /^(?:reject|no,? skip it|skip it|cancel it)$/i.test(value)) return 'reject';
  return null;
}

function learnedResponse() {
  const status = adaptive.status();
  const signals = adaptive.topSignals(null, 8);
  if (!signals.length) return 'Sir, Adaptive Intelligence is active, but I do not have enough explicit preference evidence yet to claim stable patterns.';
  const rows = signals.slice(0, 5).map((item) => `${item.domain}: ${item.score < 0 ? 'avoid/less' : item.score > 0 ? 'prefer/more' : 'context'} — ${item.latestText || item.text}`);
  return `Sir, Adaptive Intelligence has ${status.totalObservations} recorded observation${status.totalObservations === 1 ? '' : 's'}. Strongest learned signals: ${rows.join(' | ')}. I use these as weighted preferences, not permanent rules.`;
}

function ideaResponse(data) {
  const ideas = Array.isArray(data?.ideas) ? data.ideas : [];
  if (!ideas.length) return 'Sir, Reel Intelligence completed but did not produce a usable idea set. I would not invent ideas and call them trend-backed.';
  const top = ideas.slice(0, 6).map((idea, index) => `${index + 1}. ${idea.title} — ${idea.hook}${idea.format ? ` [${idea.format}]` : ''}`);
  const sourceTruth = data?.intelligence?.completedSources?.includes('hootsuite')
    ? 'Hootsuite completed in the latest trend run.'
    : `Latest trend mode: ${data?.intelligence?.mode || 'unknown'}; Hootsuite was not verified in that run.`;
  return `Sir, these are the strongest account-fit Reel ideas right now:\n${top.join('\n')}\n${sourceTruth}`;
}

function aestheticResponse(data) {
  if (!data) return 'Sir, I could not obtain enough Instagram profile/media evidence to build an aesthetic snapshot, so I will not invent one.';
  const visual = data.visual || {};
  const palette = (visual.palette || []).slice(0, 5).map((item) => item.hex).join(', ');
  const tags = (visual.tags || []).join(', ');
  const caption = data.captions?.available
    ? `Your recent captions average ${data.captions.averageChars} characters; CTA rate ${Math.round(Number(data.captions.ctaRate || 0) * 100)}%.`
    : 'Recent caption-pattern data was unavailable.';
  if (!visual.available) return `Sir, I could read the Instagram account metadata, but the API did not expose enough profile/feed imagery for a reliable visual aesthetic analysis. ${caption}`;
  return `Sir, your current Instagram visual signature reads as ${tags || 'mixed'}, with a sampled palette of ${palette || 'no stable palette yet'}. ${caption} Reel Intelligence will use this as a soft creative constraint, not a permanent style lock.`;
}

async function executeProposalDecision(message, options = {}) {
  const decision = proposalDecisionIntent(message);
  if (!decision) return null;
  const pending = adaptive.pendingProposals();
  if (!pending.length) {
    const response = 'Sir, there is no pending Adaptive Intelligence proposal to approve or reject.';
    return { ok: true, response, text: response, model: 'adaptive-intelligence', provider: 'local', taskType: 'adaptive-decision', mode: 'fastpath', inputMode: options.inputMode || 'chat' };
  }
  const proposal = adaptive.resolveLatestProposal(decision, { userMessage: message });
  if (!proposal) return null;
  if (decision === 'reject') {
    const response = `Rejected, Sir. I recorded that feedback and will reduce the weight of similar ${proposal.domain || 'adaptive'} suggestions.`;
    return { ok: true, response, text: response, model: 'adaptive-intelligence', provider: 'local', taskType: 'adaptive-decision', mode: 'adaptive-rejected', inputMode: options.inputMode || 'chat', adaptiveProposal: proposal };
  }
  if (!originalHandle) {
    const response = `Approved, Sir. The proposal is recorded as approved, but the execution wrapper is not active in this process.`;
    return { ok: false, response, text: response, model: 'adaptive-intelligence', provider: 'local', taskType: 'adaptive-decision', mode: 'adaptive-approved-no-runtime', inputMode: options.inputMode || 'chat', adaptiveProposal: proposal };
  }
  const executionPrompt = [
    'USER-APPROVED ADAPTIVE ACTION. Execute it now through normal ULTRON tools/capabilities if executable.',
    `Proposal: ${proposal.title}`,
    `Rationale: ${proposal.rationale || 'none'}`,
    `Approved action: ${proposal.action}`,
    'The user explicitly approved this proposal in the immediately preceding message. Do not ask for the same approval again unless the underlying tool itself requires a distinct confirmation for a more consequential action not described in the proposal. Verify execution normally.',
  ].join('\n');
  const result = await originalHandle(executionPrompt, { ...options, adaptiveApprovedProposalId: proposal.id });
  return { ...result, mode: 'adaptive-approved-execution', adaptiveProposal: proposal };
}

async function handleSpecial(message, options = {}) {
  const proposalDecision = await executeProposalDecision(message, options);
  if (proposalDecision) return proposalDecision;
  if (isLearningStatusRequest(message)) {
    const response = learnedResponse();
    adaptive.observeTurn(message, response, { taskType: 'adaptive-status', mode: 'local' });
    return { ok: true, response, text: response, model: 'adaptive-intelligence', provider: 'local', taskType: 'adaptive-status', mode: 'fastpath', inputMode: options.inputMode || 'chat' };
  }
  if (isInstagramAestheticRequest(message)) {
    let data = null;
    let error = null;
    try { data = await instagramAesthetic.analyze({ limit: 10 }); }
    catch (cause) { error = cause.message; data = instagramAesthetic.latest(); }
    let response = aestheticResponse(data);
    if (error && !data) response += ` Instagram analysis error: ${error}`;
    adaptive.observeTurn(message, response, { taskType: 'instagram-aesthetic', mode: 'official-instagram-api' });
    return { ok: Boolean(data), response, text: response, model: 'instagram-aesthetic', provider: 'official-instagram-api+local-ffmpeg', taskType: 'analysis', mode: 'instagram-aesthetic', inputMode: options.inputMode || 'chat', aesthetic: data || null, error };
  }
  if (isTrendRefreshRequest(message)) {
    const intel = await reelIntelligence.refreshTrends({});
    const hootsuite = intel.completedSources?.includes('hootsuite') ? 'Hootsuite completed' : 'Hootsuite did not complete';
    const response = `Sir, Reel Intelligence refreshed. ${hootsuite}; mode=${intel.mode}; ${intel.formats?.length || 0} current format pattern${intel.formats?.length === 1 ? '' : 's'} stored for the Reel Director.`;
    adaptive.observeTurn(message, response, { taskType: 'reel-intelligence-refresh', mode: 'research' });
    return { ok: true, response, text: response, model: 'reel-intelligence', provider: 'research-agent', taskType: 'research', mode: 'reel-intelligence-refresh', inputMode: options.inputMode || 'chat' };
  }
  if (isReelIdeaRequest(message)) {
    const data = await reelIntelligence.suggestIdeas({ topic: message, limit: 6 });
    const response = ideaResponse(data);
    adaptive.observeTurn(message, response, { taskType: 'reel-ideas', mode: 'reel-intelligence' });
    return { ok: true, response, text: response, model: 'reel-intelligence', provider: 'mark3-router', taskType: 'planning', mode: 'reel-intelligence', inputMode: options.inputMode || 'chat', intelligence: { selectedFormats: data.selectedFormats?.map((item) => item.name) || [], trendMode: data.intelligence?.mode || null } };
  }
  return null;
}

function install() {
  if (installed) return { installed: true, alreadyInstalled: true, status: adaptive.status() };
  originalHandle = assistant.handle;
  assistant.handle = async (message, options = {}) => {
    const special = await handleSpecial(message, options);
    if (special) return special;
    const result = await originalHandle(message, options);
    const response = String(result?.response || result?.text || '').trim();
    try { adaptive.observeTurn(message, response, { taskType: result?.taskType || options.taskType || null, mode: result?.mode || null }); } catch {}
    try { reelLearning.recordFeedback(message); } catch {}
    return result;
  };
  installed = true;
  try { adaptive.maybeEmitDailySuggestion(); } catch {}
  timer = setInterval(() => {
    try { adaptive.maybeEmitDailySuggestion(); } catch {}
  }, 6 * 60 * 60 * 1000);
  timer.unref?.();
  return { installed: true, status: adaptive.status() };
}

function uninstall() {
  if (timer) clearInterval(timer);
  timer = null;
  if (installed && originalHandle) assistant.handle = originalHandle;
  originalHandle = null;
  installed = false;
  return { installed: false };
}

function status() { return { installed, adaptive: adaptive.status(), reelIntelligence: reelIntelligence.status(), instagramAesthetic: instagramAesthetic.status(), reelLearning: reelLearning.status() }; }

module.exports = { isLearningStatusRequest, isReelIdeaRequest, isTrendRefreshRequest, isInstagramAestheticRequest, proposalDecisionIntent, learnedResponse, ideaResponse, aestheticResponse, executeProposalDecision, handleSpecial, install, uninstall, status };
