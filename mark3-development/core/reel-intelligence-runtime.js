const factory = require('./reel-factory');
const intelligence = require('./reel-intelligence');
const youtube = require('./youtube-intelligence');
const { writeJsonAtomic } = require('./persistence');

let installed = false;
let originalCreateJob = null;

function compactIntel(ctx, youtubeSignal = null) {
  return {
    selectedFormats: (ctx?.selectedFormats || []).map((item) => item.name).filter(Boolean),
    trendMode: ctx?.intelligence?.mode || null,
    completedSources: ctx?.intelligence?.completedSources || [],
    trendUpdatedAt: ctx?.intelligence?.updatedAt || null,
    aestheticTags: ctx?.aesthetic?.visual?.tags || [],
    palette: (ctx?.aesthetic?.visual?.palette || []).slice(0, 5),
    creatorPreferences: ctx?.adaptive?.creator?.preferences || [],
    designPreferences: ctx?.adaptive?.design?.preferences || [],
    youtube: youtubeSignal?.available ? {
      provider: youtubeSignal.provider,
      capturedAt: youtubeSignal.capturedAt,
      region: youtubeSignal.region,
      repeatedTitleTerms: (youtubeSignal.repeatedTitleTerms || []).slice(0, 8),
      topVideos: (youtubeSignal.videos || []).slice(0, 5).map((item) => ({ title: item.title, views: item.views, score: item.score, publishedAt: item.publishedAt })),
      caveat: youtubeSignal.caveat,
    } : { available: false, configured: youtube.status().configured },
  };
}

function install() {
  if (installed) return { installed: true, alreadyInstalled: true, status: intelligence.status(), youtube: youtube.status() };
  originalCreateJob = factory.createJob;
  factory.createJob = async (brief, options = {}) => {
    let ctx = null;
    let intelError = null;
    let youtubeSignal = null;
    let youtubeError = null;
    try {
      ctx = await intelligence.contextFor(brief, options.style || '', {
        forceTrendRefresh: Boolean(options.forceTrendRefresh),
        forceAestheticRefresh: Boolean(options.forceAestheticRefresh),
      });
    } catch (error) {
      intelError = error.message;
    }

    if (youtube.status().configured && options.youtubeIntelligence !== false) {
      try {
        youtubeSignal = await youtube.analyze(brief, { force: Boolean(options.forceYouTubeRefresh), regionCode: options.regionCode || 'IN', days: options.youtubeDays || 45 });
      } catch (error) {
        youtubeError = error.message;
      }
    }

    const crossPlatform = youtubeSignal?.available ? `\n${youtube.summary(youtubeSignal)}` : '';
    const intelligenceContext = ctx ? `${ctx.context}${crossPlatform}` : crossPlatform.trim();
    const enrichedOptions = intelligenceContext
      ? { ...options, style: intelligence.enrichedStyle(options.style || '', intelligenceContext) }
      : options;
    const result = await originalCreateJob(brief, enrichedOptions);
    const intel = ctx || youtubeSignal?.available
      ? compactIntel(ctx, youtubeSignal)
      : { error: intelError || youtubeError || 'Reel Intelligence unavailable.' };

    if (result?.plan) {
      result.plan.intelligence = intel;
      result.plan.intelligenceApplied = Boolean(ctx || youtubeSignal?.available);
      if (result?.paths?.plan) writeJsonAtomic(result.paths.plan, result.plan);
    }
    if (result?.job) {
      result.job.intelligence = intel;
      result.job.intelligenceApplied = Boolean(ctx || youtubeSignal?.available);
      result.job.intelligenceError = [intelError, youtubeError].filter(Boolean).join(' | ') || null;
      if (result?.paths?.job) writeJsonAtomic(result.paths.job, result.job);
    }
    return result;
  };
  installed = true;
  return { installed: true, status: intelligence.status(), youtube: youtube.status() };
}

function uninstall() {
  if (!installed || !originalCreateJob) return { installed: false };
  factory.createJob = originalCreateJob;
  originalCreateJob = null;
  installed = false;
  return { installed: false };
}

function status() { return { installed, intelligence: intelligence.status(), youtube: youtube.status() }; }

module.exports = { install, uninstall, status, compactIntel };
