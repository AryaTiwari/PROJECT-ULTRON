const fs = require('fs');
const path = require('path');
const factory = require('./reel-factory');
const pipeline = require('./reel-pipeline');
const fileVault = require('./file-vault');
const characterUniverse = require('./elevate-character-universe');

let installed = false;
let originalHandle = null;

function isReelFactoryRequest(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  if (/\b(?:post|publish|schedule|upload)\b[\s\S]{0,80}\b(?:reel|instagram|ig)\b|\b(?:reel|instagram|ig)\b[\s\S]{0,80}\b(?:post|publish|schedule|upload)\b/i.test(value)) return false;
  return /\b(?:make|create|generate|produce|craft|prepare)\b[\s\S]{0,100}\b(?:reel|instagram video|short-form video|short form video)\b|\b(?:reel|instagram video)\b[\s\S]{0,80}\b(?:make|create|generate|produce)\b/i.test(value);
}

function isReelAttachmentRequest(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  if (/\b(?:post|publish|schedule|upload)\b[\s\S]{0,80}\b(?:instagram|ig)\b|\b(?:instagram|ig)\b[\s\S]{0,80}\b(?:post|publish|schedule|upload)\b/i.test(value)) return false;
  return /\b(?:attach|send|show|give|open|download|share)\b[\s\S]{0,60}\b(?:last|latest|recent|previous)?\s*reel\b|\b(?:last|latest|recent|previous)\s+reel\b[\s\S]{0,50}\b(?:file|attach|send|show|download|open)\b/i.test(value);
}

function isReelStatusRequest(text) {
  return /\b(?:reel factory|reel generator|reel engine)\b[\s\S]{0,30}\b(?:status|ready|readiness|working)\b|\b(?:status|check)\b[\s\S]{0,30}\b(?:reel factory|reel generator)\b/i.test(String(text || ''));
}

function parseDuration(text) {
  const match = String(text || '').match(/\b(1[5-9]|[2-5]\d|60)\s*(?:s|sec|secs|second|seconds)\b/i);
  return match ? Number(match[1]) : 30;
}

function parseStyle(text) {
  const value = String(text || '').toLowerCase();
  const tags = [];
  for (const tag of ['dark', 'cinematic', 'minimal', 'premium', 'luxury', 'fast-paced', 'fast paced', 'energetic', 'educational', 'storytelling', 'gen-z', 'gen z']) {
    if (value.includes(tag)) tags.push(tag.replace('fast paced', 'fast-paced').replace('gen z', 'gen-z'));
  }
  return tags.length ? [...new Set(tags)].join(', ') : 'cinematic, fast-paced, premium creator reel';
}

function extractBrief(text) {
  let value = String(text || '').trim().replace(/^ultron[,:]?\s*/i, '');
  const about = value.match(/\b(?:reel|instagram video|short-form video|short form video)\b[\s\S]{0,45}?\b(?:about|on|explaining|covering)\b\s+(.+)$/i);
  if (about?.[1]) return about[1].trim().replace(/[.!?]+$/, '');
  value = value
    .replace(/^\s*(?:please\s+)?(?:make|create|generate|produce|craft|prepare)\s+(?:me\s+)?(?:a\s+)?(?:\d+\s*(?:s|sec|secs|second|seconds)\s+)?/i, '')
    .replace(/\b(?:reel|instagram video|short-form video|short form video)\b/i, '')
    .replace(/^\s*(?:about|on|for)\s+/i, '')
    .trim();
  return value || 'a high-retention creator growth insight';
}

function readinessSnapshot() {
  const state = factory.status();
  const characters = characterUniverse.status();
  const blocker = !characters.configured ? characters.installHint : (state.nextBlocker || null);
  return {
    ready: !blocker,
    blocker,
    stockReady: Boolean(state.stockSourceReady),
    ffmpegReady: Boolean(state.ffmpeg?.available),
    narratorReady: Boolean(state.narrator?.configured),
    characterReady: Boolean(characters.configured),
    characterUniverse: characters,
    state,
  };
}

function statusText() {
  const readiness = readinessSnapshot();
  const stock = readiness.stockReady ? 'stock/public media ready' : 'stock source unavailable';
  const ffmpeg = readiness.ffmpegReady ? 'FFmpeg ready' : 'FFmpeg missing';
  const narrator = readiness.narratorReady ? 'Reel narrator ready' : 'Reel narrator missing';
  const characters = readiness.characterReady ? 'seven-character Elevate universe ready' : 'Elevate character reference missing';
  const blocker = readiness.blocker ? ` Current blocker: ${readiness.blocker}` : ' Production readiness is green.';
  return `Sir, Reel Factory is active: ${stock}, ${ffmpeg}, ${narrator}, ${characters}, AI direction ready, character-first storyline direction ready, semantic graphics ready, and the finished MP4 renderer is installed.${blocker} Generation stays zero-cost-only; publishing remains a separate Instagram action.`;
}

function artifactName(result) {
  const raw = String(result?.job?.id || `reel-${Date.now()}`)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
  return `${raw || 'ultron-reel'}.mp4`;
}

function registerReelArtifact(result, brief) {
  const rawPath = String(result?.output?.path || '').trim();
  if (!rawPath) throw new Error('Rendered Reel file path is unavailable for chat attachment.');
  const outputPath = path.resolve(rawPath);
  if (!fs.existsSync(outputPath) || !fs.statSync(outputPath).isFile()) {
    throw new Error('Rendered Reel file is unavailable for chat attachment.');
  }
  const entry = fileVault.saveBuffer(fs.readFileSync(outputPath), {
    name: artifactName(result),
    mime: 'video/mp4',
    kind: 'generated',
    source: 'reel-factory',
    metadata: {
      jobId: result?.job?.id || null,
      brief: String(brief || '').slice(0, 1200),
      durationSec: Number(result?.output?.durationSec || result?.plan?.durationSec || 0) || null,
      captionsApplied: Boolean(result?.polish?.captionsApplied),
      musicApplied: Boolean(result?.polish?.musicApplied),
      characterUniverseApplied: Boolean(result?.polish?.characterUniverse?.applied),
      characterCastUsed: result?.polish?.characterUniverse?.castUsed || [],
      originalPath: outputPath,
    },
  });
  return {
    ...entry,
    downloadUrl: `/api/files/download?id=${encodeURIComponent(entry.id)}`,
    inlineUrl: `/api/files/download?id=${encodeURIComponent(entry.id)}&inline=1`,
  };
}

function readJsonIfPresent(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function latestRenderedReel() {
  if (!fs.existsSync(factory.REEL_ROOT)) return null;
  const candidates = [];
  for (const name of fs.readdirSync(factory.REEL_ROOT)) {
    const dir = path.join(factory.REEL_ROOT, name);
    let stat;
    try { stat = fs.statSync(dir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    const outputPath = path.join(dir, 'reel.mp4');
    if (!fs.existsSync(outputPath)) continue;
    const outputStat = fs.statSync(outputPath);
    if (!outputStat.isFile() || outputStat.size < 100 * 1024) continue;
    candidates.push({ name, dir, outputPath, mtimeMs: outputStat.mtimeMs, bytes: outputStat.size });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const latest = candidates[0];
  if (!latest) return null;

  const job = readJsonIfPresent(path.join(latest.dir, 'job.json')) || { id: latest.name };
  const plan = readJsonIfPresent(path.join(latest.dir, 'plan.json')) || {};
  return {
    job: { ...job, id: job.id || latest.name },
    plan,
    output: {
      path: latest.outputPath,
      bytes: Number(job?.output?.bytes || latest.bytes),
      durationSec: Number(job?.output?.durationSec || plan?.durationSec || 0) || null,
    },
    polish: job?.polish || {},
  };
}

function attachLatestReelResponse() {
  const result = latestRenderedReel();
  if (!result) return { ok: false, text: 'Sir, I could not find a previously rendered Reel to attach.', result: null, artifact: null, error: 'No previously rendered Reel was found.' };
  try {
    const artifact = registerReelArtifact(result, result?.job?.brief || result?.plan?.title || 'latest rendered reel');
    const mb = (Number(result.output?.bytes || 0) / 1024 / 1024).toFixed(2);
    return {
      ok: true,
      text: `Attached, Sir. This is the latest rendered Reel (${mb} MB). You can preview it here or open/save the MP4. I have not published it to Instagram.`,
      result,
      artifact,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      text: `Sir, I found the latest Reel but could not attach it: ${error.message}`,
      result,
      artifact: null,
      artifactError: error.message,
      error: error.message,
    };
  }
}

async function buildReelResponse(requestText) {
  const readiness = readinessSnapshot();
  if (!readiness.ready) {
    const blocker = readiness.blocker || 'Reel Factory is not production-ready.';
    return {
      ok: false,
      error: blocker,
      text: `Sir, Reel Factory is installed but cannot start production yet. Blocker: ${blocker}`,
      result: { ok: false, blocker, readiness },
      artifact: null,
    };
  }

  const brief = extractBrief(requestText);
  const durationSec = parseDuration(requestText);
  const style = parseStyle(requestText);
  const result = await pipeline.build(brief, { durationSec, style, polish: true, music: true, characters: true });
  if (!result.ok) {
    const blocker = result.blocker || result.job?.finishingError || result.job?.narrationError || result.job?.polishError || 'unknown production blocker';
    return {
      ok: false,
      error: blocker,
      text: `Sir, Reel Factory stopped safely before completion. Blocker: ${blocker}`,
      result,
      artifact: null,
    };
  }

  let artifact = null;
  let artifactError = null;
  try {
    artifact = registerReelArtifact(result, brief);
  } catch (error) {
    artifactError = error.message;
  }

  const mb = (Number(result.output?.bytes || 0) / 1024 / 1024).toFixed(2);
  const captions = result.polish?.captionsApplied ? 'captions applied' : 'caption overlay skipped';
  const music = result.polish?.musicApplied ? 'background music mixed' : 'no local music track configured';
  const graphics = result.polish?.graphicsEngine?.applied ? 'semantic graphics applied' : 'semantic graphics not required';
  const characters = result.polish?.characterUniverse?.applied
    ? `Elevate character universe applied (${(result.polish.characterUniverse.castUsed || []).join(', ')})`
    : 'character universe missing';
  const duration = Math.round(result.output?.durationSec || durationSec);
  const responseText = artifact
    ? `Done, Sir. I created the character-first Elevate Reel and attached it here for preview or download. ${mb} MB, ${duration} seconds, ${characters}, ${captions}, ${graphics}, ${music}. It is rendered and verified. I have not published it to Instagram.`
    : `Done, Sir. I created and verified the character-first Reel, but I could not attach it in chat: ${artifactError || 'file delivery failed'}. The local file is at ${result.output.path}. I have not published it to Instagram.`;

  return { ok: true, error: null, text: responseText, result, artifact, artifactError };
}

function install() {
  if (installed) return { installed: true, alreadyInstalled: true };
  const assistant = require('./assistant');
  const conversation = require('./conversation');
  const voice = require('./voice-orchestrator');
  const { emit } = require('./events');
  if (!assistant?.handle) throw new Error('Assistant handle is unavailable for Reel Factory Operator.');
  originalHandle = assistant.handle;

  assistant.handle = async (message, options = {}) => {
    const text = String(message || '').trim();
    const inputMode = String(options.inputMode || 'chat').toLowerCase() === 'voice' ? 'voice' : 'chat';

    if (isReelStatusRequest(text)) {
      const response = statusText();
      conversation.append('user', text, { taskType: 'reel-factory-status', inputMode });
      conversation.append('assistant', response, { model: 'reel-factory', provider: 'local', taskType: 'reel-factory-status', inputMode });
      emit('reel_factory_status_requested', { inputMode, status: readinessSnapshot() });
      void voice.enqueue(response);
      return { ok: true, response, text: response, model: 'reel-factory', provider: 'local', taskType: 'reel-factory-status', mode: 'operator', inputMode, toolRounds: 0 };
    }

    if (isReelAttachmentRequest(text)) {
      conversation.append('user', text, { taskType: 'reel-factory-attachment', inputMode });
      const attached = attachLatestReelResponse();
      const artifacts = attached.artifact ? [attached.artifact] : [];
      conversation.append('assistant', attached.text, {
        model: 'reel-factory', provider: 'local', taskType: 'reel-factory-attachment', inputMode,
        ok: attached.ok, artifactId: attached.artifact?.id || null,
      });
      emit(attached.ok ? 'reel_factory_artifact_attached' : 'reel_factory_artifact_failed', {
        inputMode,
        artifactId: attached.artifact?.id || null,
        output: attached.result?.output?.path || null,
        error: attached.error || attached.artifactError || null,
      });
      void voice.enqueue(attached.text);
      return {
        ok: attached.ok,
        response: attached.text,
        text: attached.text,
        model: 'reel-factory',
        provider: 'local',
        taskType: 'reel-factory-attachment',
        mode: 'operator',
        inputMode,
        reel: attached.result,
        artifacts,
        error: attached.ok ? null : (attached.error || attached.artifactError || attached.text),
        toolRounds: 0,
      };
    }

    if (!isReelFactoryRequest(text)) return originalHandle(message, options);

    conversation.append('user', text, { taskType: 'reel-factory', inputMode });
    emit('reel_factory_started', { inputMode, brief: extractBrief(text), durationSec: parseDuration(text), style: parseStyle(text) });
    try {
      const built = await buildReelResponse(text);
      const artifacts = built.artifact ? [built.artifact] : [];
      conversation.append('assistant', built.text, {
        model: 'reel-factory', provider: 'local+free-stock+character-universe', taskType: 'reel-factory', inputMode,
        ok: built.ok, artifactId: built.artifact?.id || null,
      });
      emit(
        built.ok ? 'reel_factory_completed' : 'reel_factory_blocked',
        built.ok
          ? { inputMode, output: built.result.output?.path, jobId: built.result.job?.id, artifactId: built.artifact?.id || null, artifactError: built.artifactError || null, characters: built.result.polish?.characterUniverse?.castUsed || [] }
          : { inputMode, blocker: built.error || built.result?.blocker || 'unknown production blocker' }
      );
      void voice.enqueue(built.text);
      return {
        ok: built.ok,
        response: built.text,
        text: built.text,
        model: 'reel-factory',
        provider: 'local+free-stock+character-universe',
        taskType: 'reel-factory',
        mode: 'operator',
        inputMode,
        reel: built.result,
        artifacts,
        artifactError: built.artifactError || null,
        error: built.ok ? null : (built.error || built.result?.blocker || built.text),
        toolRounds: 0,
      };
    } catch (error) {
      const response = `Sir, Reel Factory failed safely: ${error.message}`;
      conversation.append('assistant', response, { model: 'reel-factory', provider: 'local+free-stock+character-universe', taskType: 'reel-factory', inputMode, ok: false });
      emit('reel_factory_failed', { inputMode, error: error.message });
      void voice.enqueue(response);
      return { ok: false, response, text: response, model: 'reel-factory', provider: 'local+free-stock+character-universe', taskType: 'reel-factory', mode: 'operator', inputMode, error: error.message, artifacts: [], toolRounds: 0 };
    }
  };

  installed = true;
  emit('reel_factory_operator_ready', { status: readinessSnapshot() });
  return { installed: true, status: readinessSnapshot() };
}

function uninstall() {
  if (!installed) return;
  const assistant = require('./assistant');
  if (originalHandle) assistant.handle = originalHandle;
  originalHandle = null;
  installed = false;
}

function status() { return { installed, factory: factory.status(), characters: characterUniverse.status() }; }

module.exports = {
  install,
  uninstall,
  status,
  isReelFactoryRequest,
  isReelAttachmentRequest,
  isReelStatusRequest,
  parseDuration,
  parseStyle,
  extractBrief,
  readinessSnapshot,
  statusText,
  artifactName,
  registerReelArtifact,
  latestRenderedReel,
  attachLatestReelResponse,
  buildReelResponse,
};
