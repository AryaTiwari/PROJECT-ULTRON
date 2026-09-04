const fs = require('fs');
const path = require('path');
const factory = require('./reel-factory');
const pipeline = require('./reel-pipeline');
const fileVault = require('./file-vault');

let installed = false;
let originalHandle = null;

function isReelFactoryRequest(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  if (/\b(?:post|publish|schedule|upload)\b[\s\S]{0,80}\b(?:reel|instagram|ig)\b|\b(?:reel|instagram|ig)\b[\s\S]{0,80}\b(?:post|publish|schedule|upload)\b/i.test(value)) return false;
  return /\b(?:make|create|generate|produce|craft|prepare)\b[\s\S]{0,100}\b(?:reel|instagram video|short-form video|short form video)\b|\b(?:reel|instagram video)\b[\s\S]{0,80}\b(?:make|create|generate|produce)\b/i.test(value);
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

function statusText() {
  const state = factory.status();
  const stock = state.stockSourceReady ? 'stock source ready' : 'stock source credentials missing';
  const ffmpeg = state.ffmpeg.available ? 'FFmpeg ready' : 'FFmpeg missing';
  return `Sir, Reel Factory is active: ${stock}, ${ffmpeg}, AI direction ready, narration ready, and the finished MP4 renderer is installed. Generation stays zero-cost-only; publishing remains a separate Instagram action.`;
}

function artifactName(result) {
  const raw = String(result?.job?.id || `reel-${Date.now()}`)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
  return `${raw || 'ultron-reel'}.mp4`;
}

function registerReelArtifact(result, brief) {
  const outputPath = path.resolve(String(result?.output?.path || ''));
  if (!outputPath || !fs.existsSync(outputPath) || !fs.statSync(outputPath).isFile()) {
    throw new Error('Rendered Reel file is unavailable for chat attachment.');
  }
  const buffer = fs.readFileSync(outputPath);
  const entry = fileVault.saveBuffer(buffer, {
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
      originalPath: outputPath,
    },
  });
  return {
    ...entry,
    downloadUrl: `/api/files/download?id=${encodeURIComponent(entry.id)}`,
    inlineUrl: `/api/files/download?id=${encodeURIComponent(entry.id)}&inline=1`,
  };
}

async function buildReelResponse(text) {
  const brief = extractBrief(text);
  const durationSec = parseDuration(text);
  const style = parseStyle(text);
  const result = await pipeline.build(brief, { durationSec, style, polish: true, music: true });
  if (!result.ok) {
    return {
      ok: false,
      text: `Sir, Reel Factory stopped safely before completion. Blocker: ${result.blocker || 'unknown production blocker'}`,
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
  const duration = Math.round(result.output?.durationSec || durationSec);
  const text = artifact
    ? `Done, Sir. I created the Reel and attached it here for preview or download. ${mb} MB, ${duration} seconds, ${captions}, ${music}. It is rendered and verified. I have not published it to Instagram.`
    : `Done, Sir. I created and verified the Reel, but I could not attach it in chat: ${artifactError || 'file delivery failed'}. The local file is at ${result.output.path}. I have not published it to Instagram.`;

  return { ok: true, text, result, artifact, artifactError };
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
      emit('reel_factory_status_requested', { inputMode, status: factory.status() });
      void voice.enqueue(response);
      return { ok: true, response, text: response, model: 'reel-factory', provider: 'local', taskType: 'reel-factory-status', mode: 'operator', inputMode, toolRounds: 0 };
    }

    if (!isReelFactoryRequest(text)) return originalHandle(message, options);

    conversation.append('user', text, { taskType: 'reel-factory', inputMode });
    emit('reel_factory_started', { inputMode, brief: extractBrief(text), durationSec: parseDuration(text), style: parseStyle(text) });
    try {
      const built = await buildReelResponse(text);
      const artifacts = built.artifact ? [built.artifact] : [];
      conversation.append('assistant', built.text, {
        model: 'reel-factory',
        provider: 'local+free-stock',
        taskType: 'reel-factory',
        inputMode,
        ok: built.ok,
        artifactId: built.artifact?.id || null,
      });
      emit(
        built.ok ? 'reel_factory_completed' : 'reel_factory_blocked',
        built.ok
          ? { inputMode, output: built.result.output?.path, jobId: built.result.job?.id, artifactId: built.artifact?.id || null, artifactError: built.artifactError || null }
          : { inputMode, blocker: built.result.blocker }
      );
      void voice.enqueue(built.text);
      return {
        ok: built.ok,
        response: built.text,
        text: built.text,
        model: 'reel-factory',
        provider: 'local+free-stock',
        taskType: 'reel-factory',
        mode: 'operator',
        inputMode,
        reel: built.result,
        artifacts,
        artifactError: built.artifactError || null,
        toolRounds: 0,
      };
    } catch (error) {
      const response = `Sir, Reel Factory failed safely: ${error.message}`;
      conversation.append('assistant', response, { model: 'reel-factory', provider: 'local+free-stock', taskType: 'reel-factory', inputMode, ok: false });
      emit('reel_factory_failed', { inputMode, error: error.message });
      void voice.enqueue(response);
      return { ok: false, response, text: response, model: 'reel-factory', provider: 'local+free-stock', taskType: 'reel-factory', mode: 'operator', inputMode, error: error.message, artifacts: [], toolRounds: 0 };
    }
  };

  installed = true;
  emit('reel_factory_operator_ready', { status: factory.status() });
  return { installed: true, status: factory.status() };
}

function uninstall() {
  if (!installed) return;
  const assistant = require('./assistant');
  if (originalHandle) assistant.handle = originalHandle;
  originalHandle = null;
  installed = false;
}

function status() { return { installed, factory: factory.status() }; }

module.exports = {
  install,
  uninstall,
  status,
  isReelFactoryRequest,
  isReelStatusRequest,
  parseDuration,
  parseStyle,
  extractBrief,
  statusText,
  artifactName,
  registerReelArtifact,
  buildReelResponse,
};