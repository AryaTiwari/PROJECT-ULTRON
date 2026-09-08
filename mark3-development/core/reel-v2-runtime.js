const pipeline = require('./reel-pipeline');
const finisher = require('./reel-finisher');
const completion = require('./reel-completion');
const finalQuality = require('./reel-final-quality');
const reelLearning = require('./reel-learning');
const elevateReelEngine = require('./elevate-reel-engine');
const elevateThemeRadar = require('./elevate-theme-radar');
const assetRescue = require('./reel-asset-rescue');
const characterUniverse = require('./elevate-character-universe');
const characterRenderer = require('./elevate-character-renderer');
const { writeJsonAtomic } = require('./persistence');

let installed = false;
let originalBuild = null;

function install() {
  if (installed) return {
    installed: true,
    alreadyInstalled: true,
    elevateReelEngine: elevateReelEngine.status(),
    elevateThemeRadar: elevateThemeRadar.status(),
    assetCompletion: assetRescue.status(),
    characterUniverse: characterUniverse.status(),
  };
  const elevateStatus = elevateReelEngine.install();
  originalBuild = pipeline.build;
  pipeline.build = async (brief, options = {}) => {
    const characterState = characterUniverse.status();
    if (!characterState.configured) {
      return {
        ok: false,
        blocker: `Elevate character universe is not configured. ${characterState.installHint}`,
        characterUniverse: characterState,
      };
    }

    let base = await originalBuild(brief, { ...options, graphics: false });

    // External media is optional texture, never the identity of an Elevate Reel.
    // Missing provider assets are completed locally before the recurring cast is added.
    if (!base?.ok && assetRescue.missingAssetFailure(base)) {
      base = await assetRescue.rescue(base, brief, { ...options, graphics: false });
    }
    if (!base?.ok) return base;

    const themeRadar = elevateThemeRadar.snapshot(brief);
    if (base.plan) {
      base.plan = characterUniverse.decoratePlan(base.plan, brief);
      base.plan.elevateEngine = {
        ...(base.plan.elevateEngine || {}),
        themeRadar,
        assetCompletion: assetRescue.status(),
        characterUniverse: characterRenderer.status(),
      };
      if (base.paths?.plan) writeJsonAtomic(base.paths.plan, base.plan);
    }
    if (base.job) {
      base.job.elevateThemeRadar = themeRadar;
      base.job.reelAssetCompletion = assetRescue.status();
      base.job.characterUniverse = characterRenderer.status();
      if (base.paths?.job) writeJsonAtomic(base.paths.job, base.job);
    }

    let finished;
    try {
      finished = await finisher.finish(base, options);
    } catch (error) {
      const job = { ...(base.job || {}) };
      job.state = 'finishing_failed';
      job.updatedAt = new Date().toISOString();
      job.finishingError = error.message;
      if (base?.paths?.job) writeJsonAtomic(base.paths.job, job);
      return { ...base, ok: false, job, blocker: `Premium Reel finishing failed: ${error.message}` };
    }

    try {
      finished = completion.ensureComplete(finished, options);
    } catch (error) {
      const job = { ...(finished.job || base.job || {}) };
      job.state = 'waiting_narration_completion';
      job.updatedAt = new Date().toISOString();
      job.narrationCompletionError = error.message;
      if (finished?.paths?.job) writeJsonAtomic(finished.paths.job, job);
      return {
        ...finished,
        ok: false,
        job,
        blocker: `Reel narration completion gate rejected the output: ${error.message}`,
      };
    }

    const audit = finalQuality.audit(finished, brief, options);
    const job = { ...(finished.job || {}) };
    job.finalQuality = audit;
    job.finisher = finished.finisher;
    job.output = finished.output;
    job.polish = finished.polish;
    job.narration = finished.narration;
    job.completion = finished.completion;
    job.elevateReelEngine = elevateReelEngine.status();
    job.elevateThemeRadar = themeRadar;
    job.reelAssetCompletion = assetRescue.status();
    job.characterUniverse = characterRenderer.status();
    job.updatedAt = new Date().toISOString();

    if (!audit.ok) {
      job.state = 'waiting_final_quality';
      if (finished?.paths?.job) writeJsonAtomic(finished.paths.job, job);
      return {
        ...finished,
        ok: false,
        job,
        finalQuality: audit,
        blocker: `Final Reel quality gate rejected the output: ${audit.issues.join('; ')}`,
      };
    }

    job.state = 'rendered';
    job.finishedProduction = true;
    if (finished?.paths?.job) writeJsonAtomic(finished.paths.job, job);
    const result = {
      ...finished,
      ok: true,
      job,
      finalQuality: audit,
      elevateThemeRadar: themeRadar,
      reelAssetCompletion: assetRescue.status(),
      characterUniverse: characterRenderer.status(),
    };
    try {
      const recipe = reelLearning.recordRender(result);
      if (recipe) result.creativeLearning = { tracked: true, jobId: recipe.jobId };
    } catch (error) {
      result.creativeLearning = { tracked: false, error: error.message };
    }
    return result;
  };
  installed = true;
  return {
    installed: true,
    elevateReelEngine: elevateStatus,
    elevateThemeRadar: elevateThemeRadar.status(),
    assetCompletion: assetRescue.status(),
    characterUniverse: characterUniverse.status(),
  };
}

function uninstall() {
  if (!installed || !originalBuild) return { installed: false };
  pipeline.build = originalBuild;
  originalBuild = null;
  installed = false;
  return { installed: false };
}

function status() {
  return {
    installed,
    premiumFinisherRequired: true,
    narrationCompletionRequired: true,
    finalQualityGateRequired: true,
    elevateReelEngine: elevateReelEngine.status(),
    elevateThemeRadar: elevateThemeRadar.status(),
    assetCompletion: assetRescue.status(),
    characterUniverse: characterUniverse.status(),
    characterRenderer: characterRenderer.status(),
    creativeRecipeLearning: reelLearning.status(),
  };
}

module.exports = { install, uninstall, status };
