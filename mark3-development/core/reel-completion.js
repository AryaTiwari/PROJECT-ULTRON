const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const pipeline = require('./reel-pipeline');
const finisher = require('./reel-finisher');
const quality = require('./reel-quality');

function probeDuration(file) {
  const target = String(file || '').trim();
  if (!target || !fs.existsSync(target)) return null;
  try {
    const probe = spawnSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', target,
    ], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    if (probe.status !== 0) return null;
    const value = Number(String(probe.stdout || '').trim());
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function fitNarrationFile(source, destination, rate) {
  pipeline.run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', source,
    '-filter:a', `atempo=${Number(rate).toFixed(5)}`,
    '-vn', '-c:a', 'libmp3lame', '-b:a', '192k',
    destination,
  ], { timeoutMs: 180000 });
  return destination;
}

function remuxWithNarration(result, narrationPath, options = {}) {
  const plan = result?.plan || {};
  const root = result?.paths?.dir;
  if (!root) throw new Error('Reel completion guard received no job directory.');
  const tempDir = path.join(root, 'completion-temp');
  fs.mkdirSync(tempDir, { recursive: true });

  const base = path.join(tempDir, 'completion-base.mp4');
  const musicPath = options.music === false ? null : pipeline.localMusicTrack();
  const audio = pipeline.muxAudio(result.output.path, narrationPath, base, plan.durationSec, musicPath);
  const sfxPath = options.sfx === false ? null : finisher.generateSfxBed(plan, tempDir);
  const finalTemp = path.join(tempDir, 'completion-final.mp4');
  const sfx = finisher.mixSfx(base, sfxPath, finalTemp, plan.durationSec);
  fs.copyFileSync(finalTemp, result.paths.output);
  const verified = pipeline.verifyOutput(result.paths.output);
  if (!verified.audioPresent) throw new Error('Narration completion remux produced no audio track.');
  return { output: verified, audio, sfx };
}

function ensureComplete(result, options = {}) {
  if (!result?.ok) return result;
  const plan = result.plan || {};
  const source = String(result?.narration?.path || '').trim();
  if (!source || !fs.existsSync(source)) throw new Error('Narration completion guard cannot find the Reel narration file.');

  const req = quality.requirements(plan.durationSec);
  const videoDuration = Number(plan.durationSec || result?.output?.durationSec || 0);
  const tailRoomSec = Number(req.narrationTailRoomSec || 0.8);
  const spokenBudgetSec = Math.max(1, videoDuration - tailRoomSec);
  const originalDurationSec = probeDuration(source);
  if (!originalDurationSec) throw new Error('Narration completion guard could not measure the narrator audio duration.');

  let narrationPath = source;
  let timeFitRate = 1;
  let remuxed = false;

  if (originalDurationSec > spokenBudgetSec) {
    timeFitRate = originalDurationSec / spokenBudgetSec;
    if (timeFitRate > Number(req.maxNarrationTimeFitRate || 1.14)) {
      throw new Error(
        `Narration is too long to finish naturally: ${originalDurationSec.toFixed(2)}s for a ${spokenBudgetSec.toFixed(2)}s spoken budget. ` +
        `The script must be rewritten shorter instead of being cut or rushed.`
      );
    }
    narrationPath = path.join(result.paths.dir, 'narration-fitted.mp3');
    fitNarrationFile(source, narrationPath, timeFitRate);
    const remux = remuxWithNarration(result, narrationPath, options);
    result = {
      ...result,
      output: remux.output,
      polish: {
        ...(result.polish || {}),
        musicApplied: remux.audio.musicApplied,
        musicPath: remux.audio.musicPath || null,
      },
      finisher: {
        ...(result.finisher || {}),
        sfxApplied: remux.sfx.applied,
        sfxPath: remux.sfx.path || null,
        narrationCompletionRemux: true,
      },
    };
    remuxed = true;
  }

  const finalNarrationDurationSec = probeDuration(narrationPath);
  if (!finalNarrationDurationSec || finalNarrationDurationSec > spokenBudgetSec + 0.08) {
    throw new Error(
      `Narration still reaches the final frame (${Number(finalNarrationDurationSec || 0).toFixed(2)}s > ${spokenBudgetSec.toFixed(2)}s budget).`
    );
  }

  return {
    ...result,
    narration: {
      ...(result.narration || {}),
      path: narrationPath,
      originalDurationSec,
      durationSec: finalNarrationDurationSec,
      spokenBudgetSec,
      tailRoomSec,
      timeFitRate,
      timeFitted: timeFitRate > 1.001,
      completionVerified: true,
      completionPolicy: 'finish-before-final-frame-v1',
    },
    completion: {
      verified: true,
      originalNarrationDurationSec: originalDurationSec,
      finalNarrationDurationSec,
      spokenBudgetSec,
      tailRoomSec,
      timeFitRate,
      remuxed,
    },
  };
}

module.exports = {
  probeDuration,
  fitNarrationFile,
  remuxWithNarration,
  ensureComplete,
};
