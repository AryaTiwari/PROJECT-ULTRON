const operator = require('./operator');
const adaptive = require('./adaptive-intelligence');
const reelIntelligence = require('./reel-intelligence');
const reelFactory = require('./reel-factory');
const reelLearning = require('./reel-learning');
const instagram = require('./instagram');
const buffer = require('./buffer');
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
    ['conversation-history', 'context-fabric', 'persistent recent sessions + previous-thread continuity'],
    ['workspace-executions', 'context-fabric', 'verified recent work + next-focus state'],
    ['adaptive-intelligence', 'context-fabric', 'domain-scoped learned preferences'],
    ['turbo-diagnostics', 'context-fabric', 'system health + one useful next check'],
    ['context-fabric', 'assistant', 'time + prior thread + task awareness + fluid continuity'],
    ['context-fabric', 'reel-intelligence', 'shared founder context reaches model-backed creative reasoning'],
    ['conversation', 'adaptive-intelligence', 'explicit corrections + approval/rejection evidence'],
    ['reel-intelligence', 'reel-factory', 'Hootsuite/web trend + Instagram aesthetic + learned creative context'],
    ['reel-factory', 'reel-learning', 'creative recipe + user feedback'],
    ['instagram-insights', 'reel-learning', 'published performance outcome weights'],
    ['research-agent', 'research-turbo', 'primary research + Tavily fallback'],
    ['web-fetch', 'research-turbo', 'direct/TinyFish primary; Jina then Firecrawl fallback'],
    ['operator-mode', 'forge', 'large software/automation delegation'],
    ['forge-founder-recipes', 'mission-compiler', 'founder-specific automation success contracts'],
    ['forge', 'coding-brain', 'real workspace edits + validation'],
    ['forge', 'adaptive-intelligence', 'founder preferences constrain planning'],
    ['buffer', 'social-publishing', 'channel verification + approval-gated publishing path'],
    ['file-vault', 'interface', 'generated artifact delivery'],
    ['context-fabric', 'interface', 'recent chats + focus + health + connected capability mesh'],
  ].map(([from, to, contract]) => ({ from, to, contract }));
}

function audit() {
  forgePreferences.applyCurrentModelPool(forgeGovernor);
  const components = [
    component('operator', safe('operator', () => operator.summary()), true),
    component('adaptive-intelligence', safe('adaptive', () => adaptive.status()), true),
    component('reel-intelligence', safe('reel-intelligence', () => reelIntelligence.status()), false),
    component('reel-factory', safe('reel-factory', () => reelFactory.status()), false),
    component('reel-learning', safe('reel-learning', () => reelLearning.status()), false),
    component('instagram', safe('instagram', () => instagram.status()), false),
    component('buffer', safe('buffer', () => buffer.status()), false),
    component('research-turbo', safe('research-turbo', () => researchTurbo.status()), false),
    component('forge-governor', safe('forge-governor', () => forgeGovernor.status()), true),
    component('forge-recipes', safe('forge-recipes', () => ({ recipes: forgePreferences.founderRecipes.RECIPES.map((row) => row.id) })), false),
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

  const reel = reelFactory.status();
  const reelOperator = operator.status().find((row) => row.id === 'reel_generation');
  if (reelOperator?.ready && reel.nextBlocker) {
    issues.push({ component: 'operator/reel-factory', reason: `Reel Operator claims ready while Reel Factory reports blocker: ${reel.nextBlocker}` });
  }
  if (reel.rendererImplemented && !reel.ffmpeg?.available) warnings.push({ component: 'reel-factory', reason: 'Renderer code exists but FFmpeg runtime is unavailable.' });
  if (reel.voiceoverBridgeImplemented && !reel.narrator?.configured) warnings.push({ component: 'reel-factory', reason: 'Voiceover bridge exists but no dedicated Reel narrator profile is configured.' });

  const ig = instagram.status();
  if (ig.configured) {
    const publish = operator.status().find((row) => row.id === 'instagram_publish');
    if (publish && !publish.implemented) opportunities.push({ id: 'instagram-publisher', priority: 1, reason: 'Instagram identity is connected, but direct Reel publishing is still scaffolded.' });
  }

  const bufferState = buffer.status();
  if (!bufferState.configured) warnings.push({ component: 'buffer', reason: 'Buffer connector exists but BUFFER_API_KEY is not configured.' });
  else if (!bufferState.liveWriteEnabled) opportunities.push({ id: 'buffer-publisher', priority: 2, reason: 'Buffer is connected for verification/dry-run; live publishing still needs the explicit approval-gated execution wrapper.' });

  const research = researchTurbo.status();
  if (!research.searchFallbacks.includes('tavily')) warnings.push({ component: 'research-turbo', reason: 'Tavily fallback is not active.' });
  if (!research.fetchFallbacks.includes('jina-reader')) issues.push({ component: 'research-turbo', reason: 'No-key Jina extraction fallback disappeared from the research chain.' });
  if (!research.fetchFallbacks.includes('firecrawl')) warnings.push({ component: 'research-turbo', reason: 'Firecrawl extraction fallback is not active.' });

  const gov = forgeGovernor.status();
  if (!gov.zeroCostOnly || gov.paidFallbackAllowed || gov.localLlmAllowed) issues.push({ component: 'forge-governor', reason: 'Zero-cost/no-local-LLM policy regressed.' });
  if (!Array.isArray(gov.roleModels?.code_build) || !gov.roleModels.code_build.includes('deepseek-ai/deepseek-v4-pro-0813')) warnings.push({ component: 'forge-governor', reason: 'Current coding model pool was not applied.' });
  const recipes = forgePreferences.founderRecipes.RECIPES || [];
  if (recipes.length < 6) warnings.push({ component: 'forge-recipes', reason: 'Founder-specific automation recipe library is unexpectedly thin.' });

  const readyIds = new Set(operator.summary().ready.map((row) => row.id));
  if (!readyIds.has('system_audit') || !readyIds.has('adaptive_operator')) issues.push({ component: 'operator', reason: 'Turbo/Adaptive intelligence are not exposed as first-class ready Operator capabilities.' });

  const criticalCount = components.filter((item) => item.critical).length;
  const healthyCritical = components.filter((item) => item.critical && item.healthy).length;
  const base = criticalCount ? healthyCritical / criticalCount : 1;
  const score = Math.max(0, Math.min(100, Math.round(base * 100 - issues.length * 10 - warnings.length * 2)));

  return {
    generatedAt: new Date().toISOString(),
    score,
    state: issues.length ? 'degraded' : warnings.length ? 'healthy-with-gaps' : 'healthy',
    zeroCostGuard: { enabled: true, localLlmAllowed: false, paidInferenceAllowed: false },
    components,
    topology: topology(),
    issues,
    warnings,
    opportunities: opportunities.sort((a, b) => a.priority - b.priority).slice(0, 10),
    freeTools: freeTools.status(),
    forgeProfiles: Object.keys(forgePreferences.PROFILES),
    forgeRecipes: recipes.map((row) => row.id),
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
    dormantTools: report.freeTools.dormant.map((row) => row.id),
    forgeRecipes: report.forgeRecipes,
  };
}

module.exports = { topology, audit, compact };
