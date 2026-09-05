const path = require('path');
const config = require('./config');
const instagram = require('./instagram');
const learning = require('./reel-learning');
const { readJson, writeJsonAtomic } = require('./persistence');

const LINKS_PATH = path.resolve(config.projectRoot, '.ultron', 'reels', 'performance-links.json');

function load() { return readJson(LINKS_PATH, { version: 1, links: [] }); }
function save(data) { writeJsonAtomic(LINKS_PATH, data); return data; }

function linkPublishedMedia(jobId, mediaId, meta = {}) {
  const job = String(jobId || '').trim();
  const media = String(mediaId || '').trim();
  if (!job || !media) throw new Error('Reel job id and Instagram media id are required.');
  const data = load();
  const link = {
    jobId: job,
    mediaId: media,
    permalink: String(meta.permalink || '').trim() || null,
    publishedAt: meta.publishedAt || new Date().toISOString(),
    linkedAt: new Date().toISOString(),
    lastSyncedAt: null,
    lastInsights: null,
  };
  data.links = [link, ...(data.links || []).filter((item) => item.jobId !== job && item.mediaId !== media)].slice(0, 200);
  save(data);
  return link;
}

function linkForJob(jobId) {
  const job = String(jobId || '').trim();
  return (load().links || []).find((item) => item.jobId === job) || null;
}

function latestLink() { return (load().links || [])[0] || null; }

async function syncJob(jobId, options = {}) {
  const link = linkForJob(jobId);
  if (!link) throw new Error(`No Instagram media link exists for Reel job ${jobId}. The publisher must link the media id after publishing.`);
  const insights = await instagram.mediaInsights(link.mediaId, options);
  const learningResult = learning.recordOutcome(link.jobId, insights.metrics);
  const data = load();
  const stored = (data.links || []).find((item) => item.jobId === link.jobId);
  if (stored) {
    stored.lastSyncedAt = new Date().toISOString();
    stored.lastInsights = {
      metrics: insights.metrics,
      partial: insights.partial,
      unavailableMetrics: (insights.errors || []).map((item) => item.metric),
      creativeOutcomeScore: learningResult?.score ?? null,
    };
  }
  save(data);
  return {
    ok: true,
    jobId: link.jobId,
    mediaId: link.mediaId,
    metrics: insights.metrics,
    partial: insights.partial,
    metricErrors: insights.errors,
    creativeOutcome: learningResult,
    syncedAt: stored?.lastSyncedAt || new Date().toISOString(),
  };
}

async function syncLatest(options = {}) {
  const link = latestLink();
  if (!link) throw new Error('No published Reel has been linked to Instagram yet.');
  return syncJob(link.jobId, options);
}

function status() {
  const data = load();
  return {
    implemented: true,
    linkedPublishedReels: (data.links || []).length,
    insightsReaderImplemented: instagram.status().mediaInsightsImplemented,
    insightsPermissionRequired: instagram.status().insightsPermissionRequired,
    closedLoopLearning: true,
    path: LINKS_PATH,
  };
}

module.exports = { LINKS_PATH, linkPublishedMedia, linkForJob, latestLink, syncJob, syncLatest, status };
