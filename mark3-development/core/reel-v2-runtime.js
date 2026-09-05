const pipeline = require('./reel-pipeline');
const finisher = require('./reel-finisher');
const finalQuality = require('./reel-final-quality');
const reelLearning = require('./reel-learning');
const { writeJsonAtomic } = require('./persistence');

let installed = false;
let originalBuild = null;

function install() {
  if (installed) return { installed: true, alreadyInstalled: true };
  originalBuild = pipeline.build;
  pipeline.build = async (brief, options = {}) => {
    const base = await originalBuild(brief, options);
    if (!base?.ok) return base;

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

    const audit = finalQuality.audit(finished, brief, options);
    const job = { ...(finished.job || {}) };
    job.finalQuality = audit;
    job.finisher = finished.finisher;
    job.output = finished.output;
    job.polish = finished.polish;
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
    const result = { ...finished, ok: true, job, finalQuality: audit };
    try {
      const recipe = reelLearning.recordRender(result);
      if (recipe) result.creativeLearning = { tracked: true, jobId: recipe.jobId };
    } catch (error) {
      result.creativeLearning = { tracked: false, error: error.message };
    }
    return result;
  };
  installed = true;
  return { installed: true };
}

function uninstall() {
  if (!installed || !originalBuild) return { installed: false };
  pipeline.build = originalBuild;
  originalBuild = null;
  installed = false;
  return { installed: false };
}

function status() { return { installed, premiumFinisherRequired: true, finalQualityGateRequired: true, creativeRecipeLearning: reelLearning.status() }; }

module.exports = { install, uninstall, status };
