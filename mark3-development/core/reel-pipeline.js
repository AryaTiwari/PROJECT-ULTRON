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

function findCaptionFont() {
  const candidates = process.platform === 'win32'
    ? [
      'C:\\Windows\\Fonts\\arialbd.ttf',
      'C:\\Windows\\Fonts\\segoeuib.ttf',
      'C:\\Windows\\Fonts\\calibrib.ttf',
    ]
    : [
      '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
      '/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf',
    ];
  return candidates.find((file) => fs.existsSync(file)) || null;
}

function ffmpegPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:').replace(/'/g, "\\'");
}

function drawtextEscape(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function captionText(scene, plan, index) {
  const explicit = String(scene?.onScreenText || '').trim();
  if (explicit) return explicit;
  const narration = String(scene?.narration || '').trim();
  if (narration) return narration;
  if (index === 0) return String(plan?.hook || plan?.title || '').trim();
  return String(scene?.purpose || '').trim();
}

function localMusicTrack() {
  const configured = String(process.env.ULTRON_M3_REEL_MUSIC || '').trim();
  if (configured && fs.existsSync(configured)) return configured;
  const dir = path.resolve(factory.REEL_ROOT, 'music');
  try {
    const files = fs.readdirSync(dir)
      .filter((name) => /\.(?:mp3|wav|m4a|aac|ogg|flac)$/i.test(name))
      .map((name) => path.join(dir, name));
    return files[0] || null;
  } catch {
    return null;
  }
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
    '-vf', 'scale=1160:2062:force_original_aspect_ratio=increase,crop=1080:1920,eq=contrast=1.04:saturation=1.06,fps=30',
    '-an',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
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

function applyVisualPolish(videoPath, plan, tempDir) {
  const font = findCaptionFont();
  if (!font) return { path: videoPath, captionsApplied: false, reason: 'caption-font-not-found' };
  const filters = ['vignette=PI/7'];
  plan.scenes.forEach((scene, index) => {
    const text = drawtextEscape(captionText(scene, plan, index));
    if (!text) return;
    const start = Math.max(0, Number(scene.start || 0));
    const end = Math.max(start + 0.1, Number(scene.end || plan.durationSec || 30));
    const hook = index === 0;
    const size = hook ? 86 : 66;
    const y = hook ? 1170 : 1370;
    filters.push([
      `drawtext=fontfile='${ffmpegPath(font)}'`,
      `text='${text.slice(0, hook ? 90 : 120)}'`,
      `fontsize=${size}`,
      'fontcolor=white',
      'borderw=4',
      'bordercolor=black@0.78',
      'box=1',
      'boxcolor=black@0.28',
      'boxborderw=24',
      'x=(w-text_w)/2',
      `y=${y}`,
      `enable='between(t,${start.toFixed(2)},${end.toFixed(2)})'`,
    ].join(':'));
  });
  const output = path.join(tempDir, 'polished.mp4');
  try {
    run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', videoPath,
      '-vf', filters.join(','),
      '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', output,
    ], { timeoutMs: 240000 });
    return { path: output, captionsApplied: filters.length > 1, font };
  } catch (error) {
    return { path: videoPath, captionsApplied: false, reason: error.message };
  }
}

function muxAudio(videoPath, narrationPath, outputPath, durationSec, musicPath = null) {
  if (!narrationPath && !musicPath) {
    fs.copyFileSync(videoPath, outputPath);
    return { musicApplied: false };
  }
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoPath];
  if (narrationPath) args.push('-i', narrationPath);
  if (musicPath) args.push('-stream_loop', '-1', '-i', musicPath);

  let filter = '';
  let audioMap = null;
  if (narrationPath && musicPath) {
    filter = '[1:a]volume=1.0[n];[2:a]volume=0.10[m];[n][m]amix=inputs=2:duration=first:dropout_transition=2[a]';
    audioMap = '[a]';
  } else if (narrationPath) {
    filter = '[1:a]apad[a]';
    audioMap = '[a]';
  } else {
    filter = '[1:a]volume=0.10,apad[a]';
    audioMap = '[a]';
  }
  args.push('-filter_complex', filter, '-map', '0:v:0', '-map', audioMap, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', Number(durationSec || 30).toFixed(3), '-movflags', '+faststart', outputPath);
  run('ffmpeg', args, { timeoutMs: 180000 });
  return { musicApplied: Boolean(musicPath), musicPath: musicPath || null };
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
  const polish = options.polish === false ? { path: silent, captionsApplied: false, reason: 'disabled' } : applyVisualPolish(silent, plan, tempDir);
  const music = options.music === false ? null : localMusicTrack();
  const audio = muxAudio(polish.path, narration?.path || null, paths.output, plan.durationSec, music);
  const verified = verifyOutput(paths.output);

  job.state = 'rendered';
  job.updatedAt = new Date().toISOString();
  job.rendererImplemented = true;
  job.narration = narration;
  job.output = verified;
  job.polish = { captionsApplied: polish.captionsApplied, font: polish.font || null, reason: polish.reason || null, musicApplied: audio.musicApplied, musicPath: audio.musicPath };
  job.attributions = materialized.downloads.map((item) => ({ attribution: item.attribution, sourcePage: item.sourcePage }));
  writeJsonAtomic(paths.job, job);
  return { ok: true, job, plan, paths, output: verified, narration, polish: job.polish };
}

module.exports = {
  run,
  findCaptionFont,
  captionText,
  localMusicTrack,
  materializeAssets,
  synthesizeNarration,
  renderScene,
  concatScenes,
  applyVisualPolish,
  muxAudio,
  verifyOutput,
  build,
};