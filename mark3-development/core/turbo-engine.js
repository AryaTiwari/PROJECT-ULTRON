const operator = require('./operator');
const adaptive = require('./adaptive-intelligence');
const reelIntelligence = require('./reel-intelligence');
const reelLearning = require('./reel-learning');
const instagram = require('./instagram');
const freeTools = require('./free-tool-registry');
const researchTurbo = require('./research-turbo-runtime');
const forgePreferences = require('./forge/preferences');
const forgeGovernor = require('./forge/model-governor');
const fileVault = require('./file-vault');
const memory = require('./memory');

function safe(label, fn, fallback = null) {
  try { return { ok: true, value: fn() }; }
  catch (error) { return { ok: false, error: `${label}: ${error.message}`, value: fallback }; }
}

function component(name, result, critical = false) {
  return {
    name,
    critical,
    healthy: Boolean(result.ok),
    error: result.ok ? null : result.error,
    status: result.value,
  };
}

function topology() {
  return [
    ['conversation', 'adaptive-intelligence', 'explicit corrections + approval/rejection evidence'],
    ['adaptive-intelligence', 'founder-behavior', 'domain-scoped learned preferences'],
    ['reel-intelligence', 'reel-factory', 'trend + aesthetic + learned creative context'],
    ['reel-factory', 'reel-learning', 'creative recipe + user feedback'],
    ['instagram-insights', 'reel-learning', 'published performance outcome weights'],
    ['research-agent', 'research-turbo', 'TinyFish primary; Tavily/Brave fallback'],
    ['web-fetch', 'research-turbo', 'direct/TinyFish primary; Firecrawl fallback'],
    ['operator-mode', 'forge', 'large software/automation delegation'],
    ['forge', 'coding-brain', 'real workspace edits + validation'],
    ['forge', 'adaptive-intelligence', 'founder preferences constrain planning'],
    ['file-vault', 'interface', 'generated artifact delivery'],
  ].map(([from, to, contract]) => ({ from, to, contract }));
}

function audit() {
  forgePreferences.applyCurrentModelPool(forgeGovernor);
  const components = [
    component('operator', safe('operator', () => operator.summary()), true),
    component('adaptive-intelligence', safe('adaptive', () => adaptive.status()), true),
    component('reel-intelligence', safe('reel-intelligence', () => reelIntelligence.status()), false),
    component('reel-learning', safe('reel-learning', () => reelLearning.status()), false),
    component('instagram', safe('instagram', () => instagram.status()), false),
    component('research-turbo', safe('research-turbo', () => researchTurbo.status()), false),
    component('forge-governor', safe('forge-governor', () => forgeGovernor.status()), true),
    component('file-vault', safe('file-vault', () => fileVault.status()), true),
    component('memory', safe('memory', () => ({ records: Array.isArray(memory.all?.()) ? memory.all().length : null })), false),
    component('free-tool-registry', safe('free-tools', () => freeTools.status()), false),
  ];

  const issues = [];
  const warnings = [];
  const opportunities = [];
  for (const item of components) {
    if (!item.healthy) (item.critical ? issues : warnings).push({ component: item.name, reason: item.error });
  }

  const op = operator.summary();
  if (op.buildNext.length) warnings.push({ component: 'operator', reason: `${op.buildNext.length} declared operator capabilities are still implementation-scaffolded, not executable.` });

  const ig = instagram.status();
  if (ig.configured) {
    const publish = operator.status().find((row) => row.id === 'instagram_publish');
    if (publish && !publish.implemented) opportunities.push({ id: 'instagram-publisher', priority: 1, reason: 'Instagram identity is connected but the publishing connector is still scaffolded.' });
    if (!freeTools.byId('cloudflare-r2')?.credentialsReady) opportunities.push({ id: 'cloudflare-r2', priority: 1, reason: 'R2 credentials would unlock the next public-media-hosting build needed for Instagram publishing.' });
    else if (!freeTools.byId('cloudflare-r2')?.implemented) opportunities.push({ id: 'cloudflare-r2-connector', priority: 1, reason: 'R2 credentials are present but the Ultron storage connector is not implemented yet.' });
  }

  const research = researchTurbo.status();
  if (!research.searchFallbacks.length) opportunities.push({ id: 'tavily', priority: 1, reason: 'TinyFish currently has no independent zero-cost search fallback.' });
  if (!research.fetchFallback) opportunities.push({ id: 'firecrawl', priority: 2, reason: 'Dynamic/hard-to-read pages currently lack a dedicated extraction fallback.' });

  if (!freeTools.byId('youtube-data')?.credentialsReady) opportunities.push({ id: 'youtube-data', priority: 1, reason: 'A YouTube API key would let us build cross-platform Shorts intelligence instead of keeping trend analysis Instagram/web-heavy.' });
  else if (!freeTools.byId('youtube-data')?.implemented) opportunities.push({ id: 'youtube-intelligence-connector', priority: 1, reason: 'YouTube credentials exist; connector implementation is the next step.' });
  if (!freeTools.byId('telegram-bot')?.credentialsReady) opportunities.push({ id: 'telegram-bot', priority: 2, reason: 'A Telegram bot token would unlock a lightweight phone command/notification surface.' });
  else if (!freeTools.byId('telegram-bot')?.implemented) opportunities.push({ id: 'telegram-remote-interface', priority: 2, reason: 'Telegram credentials exist; remote command interface still needs implementation.' });
  if (!freeTools.byId('posthog')?.credentialsReady) opportunities.push({ id: 'posthog', priority: 2, reason: 'PostHog credentials would unlock a product-analytics feedback stream for Elevate OS.' });
  else if (!freeTools.byId('posthog')?.implemented) opportunities.push({ id: 'posthog-connector', priority: 2, reason: 'PostHog credentials exist; analytics connector still needs implementation.' });

  const gov = forgeGovernor.status();
  if (!gov.zeroCostOnly || gov.paidFallbackAllowed || gov.localLlmAllowed) issues.push({ component: 'forge-governor', reason: 'Zero-cost/no-local-LLM policy regressed.' });
  if (!Array.isArray(gov.roleModels?.code_build) || !gov.roleModels.code_build.includes('deepseek-ai/deepseek-v4-pro-0813')) warnings.push({ component: 'forge-governor', reason: 'Current coding model pool was not applied.' });

  const criticalCount = components.filter((item) => item.critical).length;
  const healthyCritical = components.filter((item) => item.critical && item.healthy).length;
  const base = criticalCount ? healthyCritical / criticalCount : 1;
  const score = Math.max(0, Math.min(100, Math.round(base * 100 - issues.length * 12 - warnings.length * 2)));

  return {
    generatedAt: new Date().toISOString(),
    score,
    state: issues.length ? 'degraded' : warnings.length ? 'healthy-with-gaps' : 'healthy',
    zeroCostGuard: { enabled: true, localLlmAllowed: false, paidInferenceAllowed: false },
    components,
    topology: topology(),
    issues,
    warnings,
    opportunities: opportunities.sort((a, b) => a.priority - b.priority).slice(0, 12),
    freeTools: freeTools.status(),
    forgeProfiles: Object.keys(forgePreferences.PROFILES),
  };
}

function compact(report = audit()) {
  const topIssue = report.issues[0]?.reason || null;
  const topOpportunity = report.opportunities[0] || null;
  return {
    score: report.score,
    state: report.state,
    criticalIssue: topIssue,
    topOpportunity,
    operatorReady: operator.summary().ready.map((row) => row.id),
    operatorScaffolded: operator.summary().buildNext.map((row) => row.id),
    researchFallbacks: researchTurbo.status().searchFallbacks,
    freeToolsReady: report.freeTools.ready.map((row) => row.id),
    freeToolsCredentialed: report.freeTools.credentialed.map((row) => row.id),
  };
}

module.exports = { topology, audit, compact };
