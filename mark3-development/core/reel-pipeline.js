const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const factory = require('./reel-factory');
const sources = require('./reel-sources');
const integrations = require('./integrations');
const { writeJsonAtomic } = require('./persistence');

function run(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    encoding: 'utf8',
    timeout: Number(options.timeoutMs || 180000),
    windowsHide: true,
    cwd: options.cwd || undefined,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = String(result.stderr || result.stdout || '').trim();
    throw new Error(`${binary} failed (${result.status}): ${stderr.slice(-2500)}`);
  }
  return result;
}

function extensionFromAudio(file) {
  const ext = path.extname(String(file || '')).toLowerCase();
  return ['.wav', '.mp3', '.m4a', '.aac', '.ogg', '.flac'].includes(ext) ? ext : '.wav';
}

async function materializeAssets(plan, paths, options = {}) {
  fs.mkdirSync(paths.assets, { recursive: true });
  const scenes = [];
  const downloads = [];
  for (let i = 0; i < plan.scenes.length; i += 1) {
    const scene = plan.scenes[i];
    if (!scene.asset?.url) {
      scenes.push({ ...scene, localAsset: null });
      continue;
    }
    const destination = path.join(paths.assets, sources.safeAssetName(scene.asset, i + 1));
    try {
      const saved = fs.existsSync(destination) && fs.statSync(destination).size > 1024
        ? { ok: true, path: destination, bytes: fs.statSync(destination).size, provider: scene.asset.provider, id: scene.asset.id, attribution: scene.asset.attribution, sourcePage: scene.asset.sourcePage, reused: true }
        : await sources.downloadAsset(scene.asset, destination, options);
      downloads.push(saved);
      scenes.push({ ...scene, localAsset: saved.path });
    } catch (error) {
      scenes.push({ ...scene, localAsset: null, assetDownloadError: error.message });
    }
  }
  return { plan: { ...plan, scenes }, downloads };
}

async function synthesizeNarration(plan, paths) {
  const text = String(plan.voiceover || '').trim();
  if (!text) return { ok: false, path: null, reason: 'no-voiceover-text' };
  const result = await integrations.speak(text);
  const source = String(result?.path || '').trim();
  if (!source || !fs.existsSync(source)) throw new Error('Reel narration synthesis returned no readable audio file.');
  const destination = path.join(paths.dir, `narration${extensionFromAudio(source)}`);
  fs.copyFileSync(source, destination);
  return {
    ok: true,
    path: destination,
    provider: result.provider || 'ultron-voice',
    model: result.model || null,
    fallback: Boolean(result.fallback),
  };
}

function renderScene(scene, index, tempDir) {
  if (!scene.localAsset) throw new Error(`Scene ${index + 1} has no downloaded stock asset.`);
  const duration = Math.max(0.5, Number(scene.end || 0) - Number(scene.start || 0));
  const output = path.join(tempDir, `scene-${String(index + 1).padStart(2, '0')}.mp4`);
  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-stream_loop', '-1',
    '-i', scene.localAsset,
    '-t', duration.toFixed(3),
    '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30',
    '-an',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    output,
  ], { timeoutMs: 240000 });
  return output;
}

function concatScenes(sceneFiles, tempDir) {
  if (!sceneFiles.length) throw new Error('No rendered scenes are available to concatenate.');
  const listPath = path.join(tempDir, 'concat.txt');
  fs.writeFileSync(listPath, sceneFiles.map((file) => `file '${path.basename(file).replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
  const output = path.join(tempDir, 'silent.mp4');
  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-c', 'copy', '-movflags', '+faststart', output,
  ], { timeoutMs: 180000, cwd: tempDir });
  return output;
}

function muxNarration(videoPath, narrationPath, outputPath, durationSec) {
  if (!narrationPath) {
    fs.copyFileSync(videoPath, outputPath);
    return;
  }
  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', videoPath,
    '-i', narrationPath,
    '-filter_complex', '[1:a]apad[a]',
    '-map', '0:v:0', '-map', '[a]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    '-t', Number(durationSec || 30).toFixed(3),
    '-movflags', '+faststart',
    outputPath,
  ], { timeoutMs: 180000 });
}

function verifyOutput(outputPath) {
  if (!fs.existsSync(outputPath)) throw new Error('Reel renderer did not create the output MP4.');
  const bytes = fs.statSync(outputPath).size;
  if (bytes < 100 * 1024) throw new Error(`Rendered Reel is unexpectedly small (${bytes} bytes).`);
  let duration = null;
  try {
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', outputPath], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    if (probe.status === 0) duration = Number(String(probe.stdout || '').trim()) || null;
  } catch {}
  return { ok: true, path: outputPath, bytes, durationSec: duration };
}

async function build(brief, options = {}) {
  const created = await factory.createJob(brief, { ...options, fetchAssets: true });
  const { job, paths } = created;
  let plan = created.plan;

  if (!factory.ffmpegStatus().available) {
    job.state = 'waiting_ffmpeg';
    job.updatedAt = new Date().toISOString();
    writeJsonAtomic(paths.job, job);
    return { ok: false, job, plan, paths, blocker: 'FFmpeg is not available on PATH.' };
  }

  const materialized = await materializeAssets(plan, paths, options);
  plan = materialized.plan;
  writeJsonAtomic(paths.plan, plan);
  const missing = plan.scenes.filter((scene) => !scene.localAsset);
  if (missing.length) {
    job.state = 'waiting_assets';
    job.updatedAt = new Date().toISOString();
    job.assetErrors = missing.map((scene) => ({ scene: scene.index, error: scene.assetDownloadError || 'No stock result.' }));
    writeJsonAtomic(paths.job, job);
    return { ok: false, job, plan, paths, blocker: `${missing.length} scene(s) have no downloadable stock asset.` };
  }

  job.state = 'assets_downloaded';
  job.updatedAt = new Date().toISOString();
  job.downloadedAssets = materialized.downloads.map((item) => ({ provider: item.provider, id: item.id, path: item.path, bytes: item.bytes, attribution: item.attribution, sourcePage: item.sourcePage }));
  writeJsonAtomic(paths.job, job);

  let narration = null;
  try {
    narration = await synthesizeNarration(plan, paths);
  } catch (error) {
    narration = { ok: false, path: null, error: error.message };
  }

  const tempDir = path.join(paths.dir, 'render-temp');
  fs.mkdirSync(tempDir, { recursive: true });
  const sceneFiles = plan.scenes.map((scene, index) => renderScene(scene, index, tempDir));
  const silent = concatScenes(sceneFiles, tempDir);
  muxNarration(silent, narration?.path || null, paths.output, plan.durationSec);
  const verified = verifyOutput(paths.output);

  job.state = 'rendered';
  job.updatedAt = new Date().toISOString();
  job.rendererImplemented = true;
  job.narration = narration;
  job.output = verified;
  job.attributions = materialized.downloads.map((item) => ({ attribution: item.attribution, sourcePage: item.sourcePage }));
  writeJsonAtomic(paths.job, job);
  return { ok: true, job, plan, paths, output: verified, narration };
}

module.exports = {
  run,
  materializeAssets,
  synthesizeNarration,
  renderScene,
  concatScenes,
  muxNarration,
  verifyOutput,
  build,
};
