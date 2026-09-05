const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const factory = require('./reel-factory');
const sources = require('./reel-sources');
const narrator = require('./reel-narrator');
const quality = require('./reel-quality');
const { writeJsonAtomic } = require('./persistence');

const SAFE = {
  left: 120,
  right: 120,
  top: 270,
  bottom: 410,
  headlineY: 610,
  subtitleY: 1030,
};

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
    throw new Error(`${binary} failed (${result.status}): ${stderr.slice(-3000)}`);
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
      'C:\\Windows\\Fonts\\segoeuib.ttf',
      'C:\\Windows\\Fonts\\arialbd.ttf',
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

function cleanText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wrapText(value, maxChars = 24, maxLines = 3) {
  const words = cleanText(value).split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars || !current) current = candidate;
    else {
      lines.push(current);
      current = word;
      if (lines.length >= maxLines - 1) break;
    }
  }
  if (current && lines.length < maxLines) {
    const consumed = lines.join(' ').split(/\s+/).filter(Boolean).length;
    const remaining = words.slice(consumed).join(' ');
    const final = remaining.length > maxChars * 1.15 ? `${remaining.slice(0, Math.max(8, maxChars - 1)).trim()}…` : remaining;
    lines.push(final || current);
  }
  return lines.slice(0, maxLines).join('\n');
}

function captionText(scene, plan, index) {
  const explicit = cleanText(scene?.onScreenText);
  if (explicit) return explicit;
  if (index === 0) return cleanText(plan?.hook || plan?.title);
  return cleanText(scene?.purpose);
}

function splitCaptionChunks(value, maxWords = 6, maxChars = 34) {
  const words = cleanText(value).split(/\s+/).filter(Boolean);
  const chunks = [];
  let current = [];
  for (const word of words) {
    const candidate = [...current, word].join(' ');
    if (current.length && (current.length >= maxWords || candidate.length > maxChars)) {
      chunks.push(current.join(' '));
      current = [word];
    } else current.push(word);
  }
  if (current.length) chunks.push(current.join(' '));
  return chunks;
}

function narrationCues(plan) {
  const cues = [];
  for (const scene of plan.scenes || []) {
    if (scene.isBrandCta) continue;
    const chunks = splitCaptionChunks(scene.narration, 6, 34);
    if (!chunks.length) continue;
    const start = Number(scene.start || 0);
    const end = Number(scene.end || start + 1);
    const step = Math.max(0.35, (end - start) / chunks.length);
    chunks.forEach((text, index) => {
      const cueStart = start + index * step;
      const cueEnd = index === chunks.length - 1 ? end : Math.min(end, cueStart + step);
      cues.push({ text, start: cueStart, end: cueEnd });
    });
  }
  return cues;
}

function writeOverlayText(tempDir, name, text) {
  const file = path.join(tempDir, `${name}.txt`);
  fs.writeFileSync(file, String(text || ''), 'utf8');
  return file;
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
  const text = cleanText(plan.voiceover);
  if (!text) throw new Error('Reel narration script is empty.');
  const result = await narrator.speak(text, {
    style: plan.style,
    outputDir: paths.dir,
    filename: `narration-${Date.now()}.mp3`,
  });
  const source = String(result?.path || '').trim();
  if (!source || !fs.existsSync(source)) throw new Error('Reel narrator returned no readable audio file.');
  const destination = path.join(paths.dir, `narration${extensionFromAudio(source)}`);
  if (path.resolve(source) !== path.resolve(destination)) fs.copyFileSync(source, destination);
  return {
    ok: true,
    path: destination,
    provider: result.provider || 'reel-narrator',
    model: result.model || null,
    narratorProfile: result.narratorProfile || null,
    narratorProfileId: result.narratorProfileId || null,
    metallicApplied: Boolean(result.metallicApplied),
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
    '-vf', `scale=1180:2100:force_original_aspect_ratio=increase,crop=1080:1920,eq=contrast=1.06:saturation=1.04:brightness=-0.025,vignette=PI/8,fps=30`,
    '-an',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
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

function drawTextFileFilter(font, textFile, options = {}) {
  const start = Number(options.start || 0);
  const end = Number(options.end || start + 1);
  return [
    `drawtext=fontfile='${ffmpegPath(font)}'`,
    `textfile='${ffmpegPath(textFile)}'`,
    `fontsize=${Number(options.fontSize || 64)}`,
    `fontcolor=${options.fontColor || 'white'}`,
    `borderw=${Number(options.borderWidth ?? 3)}`,
    `bordercolor=${options.borderColor || 'black@0.70'}`,
    `box=${options.box === false ? 0 : 1}`,
    `boxcolor=${options.boxColor || 'black@0.34'}`,
    `boxborderw=${Number(options.boxBorder || 22)}`,
    `line_spacing=${Number(options.lineSpacing || 10)}`,
    'fix_bounds=1',
    'x=(w-text_w)/2',
    `y=${Number(options.y || SAFE.headlineY)}`,
    `enable='between(t,${start.toFixed(2)},${end.toFixed(2)})'`,
  ].join(':');
}

function applyVisualPolish(videoPath, plan, tempDir) {
  const font = findCaptionFont();
  if (!font) return { path: videoPath, captionsApplied: false, reason: 'caption-font-not-found', safeZoneApplied: false };
  const filters = [];
  const overlayFiles = [];

  (plan.scenes || []).forEach((scene, index) => {
    const start = Math.max(0, Number(scene.start || 0));
    const end = Math.max(start + 0.1, Number(scene.end || plan.durationSec || 30));
    if (scene.isBrandCta) {
      filters.push(`drawbox=x=70:y=430:w=940:h=760:color=black@0.62:t=fill:enable='between(t,${start.toFixed(2)},${end.toFixed(2)})'`);
      const brandFile = writeOverlayText(tempDir, `brand-${index}`, 'ELEVATE OS');
      const offerFile = writeOverlayText(tempDir, `offer-${index}`, 'Free Strategy\nSession');
      const urlFile = writeOverlayText(tempDir, `url-${index}`, 'elevateos.in');
      const noteFile = writeOverlayText(tempDir, `note-${index}`, 'Personal growth plan for your creator account');
      overlayFiles.push(brandFile, offerFile, urlFile, noteFile);
      filters.push(drawTextFileFilter(font, brandFile, { start, end, y: 545, fontSize: 46, box: false, borderWidth: 0, fontColor: 'white@0.82' }));
      filters.push(drawTextFileFilter(font, offerFile, { start, end, y: 680, fontSize: 86, box: false, borderWidth: 2, lineSpacing: 6 }));
      filters.push(drawTextFileFilter(font, noteFile, { start, end, y: 915, fontSize: 38, box: false, borderWidth: 1, fontColor: 'white@0.86' }));
      filters.push(drawTextFileFilter(font, urlFile, { start, end, y: 1035, fontSize: 54, boxColor: 'white@0.14', boxBorder: 18, borderWidth: 1 }));
      return;
    }

    const headline = wrapText(captionText(scene, plan, index), index === 0 ? 19 : 22, 3);
    if (headline) {
      const file = writeOverlayText(tempDir, `headline-${index}`, headline);
      overlayFiles.push(file);
      const headlineEnd = Math.min(end, start + Math.max(1.6, (end - start) * 0.72));
      filters.push(drawTextFileFilter(font, file, {
        start,
        end: headlineEnd,
        y: index === 0 ? 575 : SAFE.headlineY,
        fontSize: index === 0 ? 82 : 66,
        boxColor: index === 0 ? 'black@0.48' : 'black@0.36',
        boxBorder: index === 0 ? 30 : 24,
        borderWidth: 3,
        lineSpacing: 8,
      }));
    }
  });

  narrationCues(plan).forEach((cue, index) => {
    const file = writeOverlayText(tempDir, `subtitle-${index}`, wrapText(cue.text, 28, 2));
    overlayFiles.push(file);
    filters.push(drawTextFileFilter(font, file, {
      start: cue.start,
      end: cue.end,
      y: SAFE.subtitleY,
      fontSize: 48,
      boxColor: 'black@0.56',
      boxBorder: 18,
      borderWidth: 2,
      lineSpacing: 6,
    }));
  });

  if (!filters.length) return { path: videoPath, captionsApplied: false, reason: 'no-caption-text', safeZoneApplied: true };
  const output = path.join(tempDir, 'polished.mp4');
  try {
    run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', videoPath,
      '-vf', filters.join(','),
      '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', output,
    ], { timeoutMs: 300000 });
    return { path: output, captionsApplied: true, safeZoneApplied: true, font, overlayFiles: overlayFiles.length };
  } catch (error) {
    return { path: videoPath, captionsApplied: false, safeZoneApplied: false, reason: error.message };
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
    filter = '[1:a]loudnorm=I=-16:TP=-1.5:LRA=7,volume=1.0[n];[2:a]volume=0.075,highpass=f=80,lowpass=f=12000[m];[n][m]amix=inputs=2:duration=first:dropout_transition=2[a]';
    audioMap = '[a]';
  } else if (narrationPath) {
    filter = '[1:a]loudnorm=I=-16:TP=-1.5:LRA=7,apad[a]';
    audioMap = '[a]';
  } else {
    filter = '[1:a]volume=0.08,apad[a]';
    audioMap = '[a]';
  }
  args.push('-filter_complex', filter, '-map', '0:v:0', '-map', audioMap, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', Number(durationSec || 30).toFixed(3), '-movflags', '+faststart', outputPath);
  run('ffmpeg', args, { timeoutMs: 240000 });
  return { musicApplied: Boolean(musicPath), musicPath: musicPath || null };
}

function verifyOutput(outputPath) {
  if (!fs.existsSync(outputPath)) throw new Error('Reel renderer did not create the output MP4.');
  const bytes = fs.statSync(outputPath).size;
  if (bytes < 100 * 1024) throw new Error(`Rendered Reel is unexpectedly small (${bytes} bytes).`);
  let metadata = {};
  try {
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', outputPath], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    if (probe.status === 0) metadata = JSON.parse(String(probe.stdout || '{}'));
  } catch {}
  const video = (metadata.streams || []).find((stream) => stream.codec_type === 'video') || {};
  const audio = (metadata.streams || []).find((stream) => stream.codec_type === 'audio');
  const duration = Number(metadata?.format?.duration || 0) || null;
  const width = Number(video.width || 0) || null;
  const height = Number(video.height || 0) || null;
  if (width && height && (width !== 1080 || height !== 1920)) throw new Error(`Rendered Reel has wrong dimensions: ${width}x${height}.`);
  return { ok: true, path: outputPath, bytes, durationSec: duration, width, height, audioPresent: Boolean(audio) };
}

async function build(brief, options = {}) {
  const created = await factory.createJob(brief, { ...options, fetchAssets: true });
  const { job, paths } = created;
  let plan = created.plan;

  if (!job.qualityAudit?.ok) {
    job.state = 'waiting_quality';
    writeJsonAtomic(paths.job, job);
    return { ok: false, job, plan, paths, blocker: `Reel script failed quality gate: ${(job.qualityAudit?.issues || []).join('; ')}` };
  }
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

  let narration;
  try {
    narration = await synthesizeNarration(plan, paths);
  } catch (error) {
    job.state = error.code === 'REEL_NARRATOR_MISSING' ? 'waiting_narrator' : 'narration_failed';
    job.updatedAt = new Date().toISOString();
    job.narrationError = error.message;
    writeJsonAtomic(paths.job, job);
    return { ok: false, job, plan, paths, blocker: error.message };
  }

  const tempDir = path.join(paths.dir, 'render-temp');
  fs.mkdirSync(tempDir, { recursive: true });
  const sceneFiles = plan.scenes.map((scene, index) => renderScene(scene, index, tempDir));
  const silent = concatScenes(sceneFiles, tempDir);
  const polish = options.polish === false ? { path: silent, captionsApplied: false, safeZoneApplied: false, reason: 'disabled' } : applyVisualPolish(silent, plan, tempDir);
  if (!polish.captionsApplied && options.polish !== false) {
    job.state = 'polish_failed';
    job.updatedAt = new Date().toISOString();
    job.polishError = polish.reason || 'caption renderer failed';
    writeJsonAtomic(paths.job, job);
    return { ok: false, job, plan, paths, blocker: `Reel visual polish failed: ${job.polishError}` };
  }

  const music = options.music === false ? null : localMusicTrack();
  const audio = muxAudio(polish.path, narration.path, paths.output, plan.durationSec, music);
  const verified = verifyOutput(paths.output);
  if (!verified.audioPresent) throw new Error('Rendered Reel has no audio track after narrator mux.');

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
    safeZone: SAFE,
  };
  job.qualityAudit = quality.auditPlan(plan, brief, options);
  job.attributions = materialized.downloads.map((item) => ({ attribution: item.attribution, sourcePage: item.sourcePage }));
  writeJsonAtomic(paths.job, job);
  return { ok: true, job, plan, paths, output: verified, narration, polish: job.polish };
}

module.exports = {
  SAFE,
  run,
  findCaptionFont,
  cleanText,
  wrapText,
  captionText,
  splitCaptionChunks,
  narrationCues,
  writeOverlayText,
  localMusicTrack,
  materializeAssets,
  synthesizeNarration,
  renderScene,
  concatScenes,
  drawTextFileFilter,
  applyVisualPolish,
  muxAudio,
  verifyOutput,
  build,
};
