const fs = require('fs');
const path = require('path');
const pipeline = require('./reel-pipeline');

function transitionName(value) {
  const text = String(value || '').toLowerCase();
  if (/clean|fade|cinematic/.test(text)) return 'fade';
  if (/fast|slide|energy/.test(text)) return 'smoothleft';
  return 'fade';
}

function transitionDuration(sceneDuration) {
  return Math.max(0.08, Math.min(0.16, Number(sceneDuration || 2) * 0.055));
}

function renderedSceneFiles(result) {
  const tempDir = path.join(result?.paths?.dir || '', 'render-temp');
  if (!tempDir || !fs.existsSync(tempDir)) return [];
  return fs.readdirSync(tempDir)
    .filter((name) => /^scene-\d+\.mp4$/i.test(name))
    .sort()
    .map((name) => path.join(tempDir, name))
    .filter((file) => fs.existsSync(file));
}

function cinematicJoin(sceneFiles, plan, tempDir) {
  if (!sceneFiles.length) throw new Error('Premium finisher found no rendered scene files.');
  if (sceneFiles.length === 1) {
    const output = path.join(tempDir, 'cinematic-silent.mp4');
    fs.copyFileSync(sceneFiles[0], output);
    return { path: output, transitionsApplied: false, transitionCount: 0, padSec: 0 };
  }

  const scenes = Array.isArray(plan?.scenes) ? plan.scenes : [];
  const durations = sceneFiles.map((_, index) => {
    const scene = scenes[index] || {};
    return Math.max(0.5, Number(scene.end || 0) - Number(scene.start || 0));
  });
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  sceneFiles.forEach((file) => args.push('-i', file));

  const filters = [];
  sceneFiles.forEach((_, index) => {
    filters.push(`[${index}:v]fps=30,format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[v${index}]`);
  });

  let previous = '[v0]';
  let effectiveDuration = durations[0];
  let transitionCount = 0;
  for (let index = 1; index < sceneFiles.length; index += 1) {
    const duration = transitionDuration(Math.min(durations[index - 1], durations[index]));
    const offset = Math.max(0.02, effectiveDuration - duration);
    const outputLabel = `[xf${index}]`;
    const transition = transitionName(scenes[index]?.transition);
    filters.push(`${previous}[v${index}]xfade=transition=${transition}:duration=${duration.toFixed(3)}:offset=${offset.toFixed(3)}${outputLabel}`);
    previous = outputLabel;
    effectiveDuration += durations[index] - duration;
    transitionCount += 1;
  }

  const targetDuration = Number(plan?.durationSec || durations.reduce((sum, value) => sum + value, 0));
  const padSec = Math.max(0, targetDuration - effectiveDuration);
  const finalLabel = '[vout]';
  if (padSec > 0.015) filters.push(`${previous}tpad=stop_mode=clone:stop_duration=${padSec.toFixed(3)},trim=duration=${targetDuration.toFixed(3)}${finalLabel}`);
  else filters.push(`${previous}trim=duration=${targetDuration.toFixed(3)},setpts=PTS-STARTPTS${finalLabel}`);

  const output = path.join(tempDir, 'cinematic-silent.mp4');
  args.push(
    '-filter_complex', filters.join(';'),
    '-map', finalLabel,
    '-an',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    output
  );
  pipeline.run('ffmpeg', args, { timeoutMs: 360000 });
  return { path: output, transitionsApplied: transitionCount > 0, transitionCount, padSec };
}

function sfxEvents(plan) {
  const scenes = Array.isArray(plan?.scenes) ? plan.scenes : [];
  const events = [{ at: 0.04, type: 'hook', frequency: 82 }];
  scenes.slice(1).forEach((scene, index) => {
    if (scene?.isBrandCta) events.push({ at: Number(scene.start || 0) + 0.03, type: 'cta', frequency: 108 });
    else events.push({ at: Number(scene.start || 0) + 0.03, type: 'transition', frequency: index % 2 ? 92 : 116 });
  });
  return events.filter((event) => event.at >= 0 && event.at < Number(plan?.durationSec || 30));
}

function generateSfxBed(plan, tempDir) {
  const events = sfxEvents(plan);
  if (!events.length) return null;
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  events.forEach((event) => {
    args.push('-f', 'lavfi', '-i', `sine=frequency=${event.frequency}:sample_rate=44100:duration=0.14`);
  });
  const filters = events.map((event, index) => {
    const delay = Math.max(0, Math.round(event.at * 1000));
    const gain = event.type === 'hook' ? 0.14 : event.type === 'cta' ? 0.10 : 0.075;
    return `[${index}:a]volume=${gain},afade=t=out:st=0.035:d=0.105,adelay=${delay}|${delay}[s${index}]`;
  });
  filters.push(`${events.map((_, index) => `[s${index}]`).join('')}amix=inputs=${events.length}:normalize=0,alimiter=limit=0.7[sfx]`);
  const output = path.join(tempDir, 'transition-sfx.wav');
  args.push('-filter_complex', filters.join(';'), '-map', '[sfx]', '-t', Number(plan?.durationSec || 30).toFixed(3), '-c:a', 'pcm_s16le', output);
  pipeline.run('ffmpeg', args, { timeoutMs: 120000 });
  return output;
}

function mixSfx(videoPath, sfxPath, outputPath, durationSec) {
  if (!sfxPath || !fs.existsSync(sfxPath)) {
    fs.copyFileSync(videoPath, outputPath);
    return { applied: false };
  }
  pipeline.run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', videoPath,
    '-i', sfxPath,
    '-filter_complex', '[0:a]volume=1.0[a0];[1:a]volume=1.0[a1];[a0][a1]amix=inputs=2:duration=first:dropout_transition=0,alimiter=limit=0.95[a]',
    '-map', '0:v:0', '-map', '[a]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    '-t', Number(durationSec || 30).toFixed(3), '-movflags', '+faststart', outputPath,
  ], { timeoutMs: 180000 });
  return { applied: true, path: sfxPath };
}

async function finish(result, options = {}) {
  if (!result?.ok) return result;
  const plan = result.plan || {};
  const root = result?.paths?.dir;
  if (!root) throw new Error('Premium finisher received no Reel job directory.');
  const tempDir = path.join(root, 'finish-temp');
  fs.mkdirSync(tempDir, { recursive: true });

  const scenes = renderedSceneFiles(result);
  const joined = cinematicJoin(scenes, plan, tempDir);
  const polish = pipeline.applyVisualPolish(joined.path, plan, tempDir);
  if (!polish.captionsApplied || !polish.safeZoneApplied) throw new Error(`Premium caption finishing failed: ${polish.reason || 'safe-zone captions unavailable'}`);

  const narrationPath = result?.narration?.path;
  if (!narrationPath || !fs.existsSync(narrationPath)) throw new Error('Premium finisher cannot find the Reel narrator audio.');
  const musicPath = options.music === false ? null : pipeline.localMusicTrack();
  const baseAudio = path.join(tempDir, 'finished-base.mp4');
  const audio = pipeline.muxAudio(polish.path, narrationPath, baseAudio, plan.durationSec, musicPath);
  const sfxPath = options.sfx === false ? null : generateSfxBed(plan, tempDir);
  const finalTemp = path.join(tempDir, 'finished-final.mp4');
  const sfx = mixSfx(baseAudio, sfxPath, finalTemp, plan.durationSec);
  const verified = pipeline.verifyOutput(finalTemp);
  if (!verified.audioPresent) throw new Error('Premium finisher produced a Reel without audio.');

  fs.copyFileSync(finalTemp, result.paths.output);
  const finalOutput = pipeline.verifyOutput(result.paths.output);
  return {
    ...result,
    output: finalOutput,
    polish: {
      ...(result.polish || {}),
      captionsApplied: true,
      safeZoneApplied: true,
      musicApplied: audio.musicApplied,
      musicPath: audio.musicPath || null,
    },
    finisher: {
      applied: true,
      transitionsApplied: joined.transitionsApplied,
      transitionCount: joined.transitionCount,
      transitionPadSec: joined.padSec,
      sfxApplied: sfx.applied,
      sfxPath: sfx.path || null,
      zeroCost: true,
    },
  };
}

module.exports = {
  transitionName,
  transitionDuration,
  renderedSceneFiles,
  cinematicJoin,
  sfxEvents,
  generateSfxBed,
  mixSfx,
  finish,
};
