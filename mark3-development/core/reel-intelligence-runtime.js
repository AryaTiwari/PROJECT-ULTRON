const factory = require('./reel-factory');
const intelligence = require('./reel-intelligence');
const { writeJsonAtomic } = require('./persistence');

let installed = false;
let originalCreateJob = null;

function compactIntel(ctx) {
  return {
    selectedFormats: (ctx?.selectedFormats || []).map((item) => item.name).filter(Boolean),
    trendMode: ctx?.intelligence?.mode || null,
    completedSources: ctx?.intelligence?.completedSources || [],
    trendUpdatedAt: ctx?.intelligence?.updatedAt || null,
    aestheticTags: ctx?.aesthetic?.visual?.tags || [],
    palette: (ctx?.aesthetic?.visual?.palette || []).slice(0, 5),
    creatorPreferences: ctx?.adaptive?.creator?.preferences || [],
    designPreferences: ctx?.adaptive?.design?.preferences || [],
  };
}

function install() {
  if (installed) return { installed: true, alreadyInstalled: true, status: intelligence.status() };
  originalCreateJob = factory.createJob;
  factory.createJob = async (brief, options = {}) => {
    let ctx = null;
    let intelError = null;
    try {
      ctx = await intelligence.contextFor(brief, options.style || '', {
        forceTrendRefresh: Boolean(options.forceTrendRefresh),
        forceAestheticRefresh: Boolean(options.forceAestheticRefresh),
      });
    } catch (error) {
      intelError = error.message;
    }

    const enrichedOptions = ctx
      ? { ...options, style: intelligence.enrichedStyle(options.style || '', ctx.context) }
      : options;
    const result = await originalCreateJob(brief, enrichedOptions);
    const intel = ctx ? compactIntel(ctx) : { error: intelError || 'Reel Intelligence unavailable.' };

    if (result?.plan) {
      result.plan.intelligence = intel;
      result.plan.intelligenceApplied = Boolean(ctx);
      if (result?.paths?.plan) writeJsonAtomic(result.paths.plan, result.plan);
    }
    if (result?.job) {
      result.job.intelligence = intel;
      result.job.intelligenceApplied = Boolean(ctx);
      result.job.intelligenceError = intelError;
      if (result?.paths?.job) writeJsonAtomic(result.paths.job, result.job);
    }
    return result;
  };
  installed = true;
  return { installed: true, status: intelligence.status() };
}

function uninstall() {
  if (!installed || !originalCreateJob) return { installed: false };
  factory.createJob = originalCreateJob;
  originalCreateJob = null;
  installed = false;
  return { installed: false };
}

function status() { return { installed, intelligence: intelligence.status() }; }

module.exports = { install, uninstall, status, compactIntel };
