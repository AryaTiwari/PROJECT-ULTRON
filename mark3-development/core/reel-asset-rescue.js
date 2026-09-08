const fs = require('fs');
const path = require('path');
const pipeline = require('./reel-pipeline');
const assetPack = require('./reel-asset-pack');
const quality = require('./reel-quality');
const { writeJsonAtomic } = require('./persistence');

function missingAssetFailure(result = {}) {
  return Boolean(!result?.ok && result?.plan && result?.paths && (
    /scene\(s\) have no usable visual asset/i.test(String(result.blocker || '')) ||
    result?.job?.state === 'waiting_assets'
  ));
}

function assetFileName(scene, index) {
  const resolved = assetPack.resolve(scene, index);
  return `${String(index + 1).padStart(2, '0')}-internal-${resolved.id}.png`;
}

function existingDownloadRows(job = {}) {
  return Array.isArray(job.downloadedAssets) ? [...job.downloadedAssets] : [];
}

function materializeMissing(plan, paths, job = {}) {
  fs.mkdirSync(paths.assets, { recursive: true });
  const internalAssets = [];
  const scenes = (plan.scenes || []).map((scene, index) => {
    if (scene.localAsset && fs.existsSync(scene.localAsset)) return scene;
    const destination = path.join(paths.assets, assetFileName(scene, index));
    try {
      const saved = assetPack.materialize(scene, destination, { index });
      internalAssets.push(saved);
      return {
        ...scene,
        asset: {
          ...(scene.asset || {}),
          provider: saved.provider,
          id: saved.id,
          mediaType: 'image',
          generated: true,
          internalAsset: true,
          commercialUse: true,
          license: saved.license,
          attribution: saved.attribution,
          sourcePage: null,
        },
        localAsset: saved.path,
        localAssetMediaType: 'image',
        assetResolution: 'internal-asset-pack',
        externalAssetError: scene.assetDownloadError || null,
        assetDownloadError: null,
      };
    } catch (error) {
      // Do not stop production. renderSceneSafe() below has an FFmpeg-only carrier.
      return {
        ...scene,
        localAsset: null,
        localAssetMediaType: 'internal-emergency',
        assetResolution: 'ffmpeg-emergency-carrier',
        externalAssetError: scene.assetDownloadError || null,
        internalAssetError: error.message,
        assetDownloadError: null,
      };
    }
  });

  const nextPlan = { ...plan, scenes };
  const nextJob = {
    ...job,
    state: 'assets_completed',
    updatedAt: new Date().toISOString(),
    assetErrors: [],
    missingAssetTerminalFailureDisabled: true,
    internalAssetPack: assetPack.status(),
    assetFallbacks: scenes.filter((scene) => /internal|emergency/.test(String(scene.assetResolution || ''))).map((scene) => ({
      scene: scene.index,
      resolution: scene.assetResolution,
      assetId: scene.asset?.id || assetPack.resolve(scene, Number(scene.index || 1) - 1).id,
      externalError: scene.externalAssetError || null,
      internalError: scene.internalAssetError || null,
    })),
    downloadedAssets: [
      ...existingDownloadRows(job),
      ...internalAssets.map((item) => ({
        provider: item.provider,
        id: item.id,
        path: item.path,
        bytes: item.bytes,
        attribution: item.attribution,
        sourcePage: item.sourcePage,
        license: item.license,
        commercialUse: true,
        generated: true,
        mediaType: 'image',
        internalAsset: true,
      })),
    ],
  };
  if (paths.plan) writeJsonAtomic(paths.plan, nextPlan);
  if (paths.job) writeJsonAtomic(paths.job, nextJob);
  return { plan: nextPlan, job: nextJob, internalAssets };
}

function emergencyScene(scene, index, tempDir) {
  const duration = Math.max(0.5, Number(scene.end || 0) - Number(scene.start || 0));
  const output = path.join(tempDir, `scene-${String(index + 1).padStart(2, '0')}.mp4`);
  const filter = assetPack.emergencyFilter(scene);
  pipeline.run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=0x070A12:s=1080x1920:r=30:d=${duration.toFixed(3)}`,
    '-vf', `${filter},fps=30`,
    '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', output,
  ], { timeoutMs: 180000 });
  return output;
}

function renderSceneSafe(scene, index, tempDir) {
  try {
    if (scene.localAsset && fs.existsSync(scene.localAsset)) return pipeline.renderScene(scene, index, tempDir);
  } catch (error) {
    scene.assetRenderError = error.message;
  }
  return emergencyScene(scene, index, tempDir);
}

async function continueBuild(result, brief, options = {}) {
  const filled = materializeMissing(result.plan, result.paths, result.job);
  const plan = filled.plan;
  const paths = result.paths;
  const job = filled.job;

  let narration;
  try {
    narration = await pipeline.synthesizeNarration(plan, paths);
  } catch (error) {
    job.state = error.code === 'REEL_NARRATOR_MISSING' ? 'waiting_narrator' : 'narration_failed';
    job.updatedAt = new Date().toISOString();
    job.narrationError = error.message;
    if (paths.job) writeJsonAtomic(paths.job, job);
    return { ...result, ok: false, job, plan, blocker: error.message };
  }

  const tempDir = path.join(paths.dir, 'render-temp');
  fs.mkdirSync(tempDir, { recursive: true });
  const sceneFiles = plan.scenes.map((scene, index) => renderSceneSafe(scene, index, tempDir));
  const silent = pipeline.concatScenes(sceneFiles, tempDir);
  const polish = options.polish === false
    ? { path: silent, captionsApplied: false, safeZoneApplied: false, reason: 'disabled' }
    : pipeline.applyVisualPolish(silent, plan, tempDir);

  if (!polish.captionsApplied && options.polish !== false) {
    job.state = 'polish_failed';
    job.updatedAt = new Date().toISOString();
    job.polishError = polish.reason || 'caption renderer failed';
    if (paths.job) writeJsonAtomic(paths.job, job);
    return { ...result, ok: false, job, plan, blocker: `Reel visual polish failed: ${job.polishError}` };
  }

  const music = options.music === false ? null : pipeline.localMusicTrack();
  const audio = pipeline.muxAudio(polish.path, narration.path, paths.output, plan.durationSec, music);
  const verified = pipeline.verifyOutput(paths.output);
  if (!verified.audioPresent) {
    job.state = 'audio_failed';
    job.updatedAt = new Date().toISOString();
    if (paths.job) writeJsonAtomic(paths.job, job);
    return { ...result, ok: false, job, plan, blocker: 'Rendered Reel has no audio track after narrator mux.' };
  }

  job.state = 'rendered';
  job.updatedAt = new Date().toISOString();
  job.rendererImplemented = true;
  job.narration = narration;
  job.output = verified;
  job.polish = {
    captionsApplied: polish.captionsApplied,
    safeZoneApplied: polish.safeZoneApplied,
    overlayFiles: polish.overlayFiles || 0,
    font: polish.font || null,
    reason: polish.reason || null,
    musicApplied: audio.musicApplied,
    musicPath: audio.musicPath,
    safeZone: pipeline.SAFE,
    visualStyle: polish.visualStyle || null,
    textBoxes: polish.textBoxes,
    headlineSubtitleOverlapAvoided: polish.headlineSubtitleOverlapAvoided,
    eyeLevelAligned: polish.eyeLevelAligned,
    headlineY: polish.headlineY || null,
    subtitleY: polish.subtitleY || null,
    brandCtaVersion: polish.brandCtaVersion || null,
    maxHeadlineWords: polish.maxHeadlineWords || null,
    maxSubtitleWords: polish.maxSubtitleWords || null,
  };
  job.qualityAudit = quality.auditPlan(plan, brief, options);
  job.attributions = (job.downloadedAssets || []).map((item) => ({
    attribution: item.attribution,
    sourcePage: item.sourcePage,
    license: item.license || null,
    generated: Boolean(item.generated),
    internalAsset: Boolean(item.internalAsset),
  }));
  job.assetCompletion = {
    completed: true,
    unresolvedScenes: 0,
    terminalMissingAssetFailure: false,
    internalFallbackCount: (job.assetFallbacks || []).length,
    pack: assetPack.status(),
  };
  if (paths.job) writeJsonAtomic(paths.job, job);
  if (paths.plan) writeJsonAtomic(paths.plan, plan);

  return { ok: true, job, plan, paths, output: verified, narration, polish: job.polish, assetCompletion: job.assetCompletion };
}

async function rescue(result, brief, options = {}) {
  if (!missingAssetFailure(result)) return result;
  return continueBuild(result, brief, options);
}

function status() {
  return {
    implemented: true,
    terminalMissingAssetFailure: false,
    stockPreferred: true,
    internalAssetCompletion: true,
    emergencyFfmpegCarrier: true,
    assetPack: assetPack.status(),
  };
}

module.exports = { missingAssetFailure, assetFileName, materializeMissing, emergencyScene, renderSceneSafe, continueBuild, rescue, status };
