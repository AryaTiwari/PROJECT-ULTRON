const assistant = require('./assistant');
const adaptive = require('./adaptive-intelligence');
const reelIntelligence = require('./reel-intelligence');

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

async function handleSpecial(message, options = {}) {
  if (isLearningStatusRequest(message)) {
    const response = learnedResponse();
    adaptive.observeTurn(message, response, { taskType: 'adaptive-status', mode: 'local' });
    return { ok: true, response, text: response, model: 'adaptive-intelligence', provider: 'local', taskType: 'adaptive-status', mode: 'fastpath', inputMode: options.inputMode || 'chat' };
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

function status() { return { installed, adaptive: adaptive.status(), reelIntelligence: reelIntelligence.status() }; }

module.exports = { isLearningStatusRequest, isReelIdeaRequest, isTrendRefreshRequest, learnedResponse, ideaResponse, handleSpecial, install, uninstall, status };
