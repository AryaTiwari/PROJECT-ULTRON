const assistant = require('./assistant');
const conversation = require('./conversation');
const voice = require('./voice-orchestrator');
const reelOperator = require('./reel-operator-bootstrap');
const { emit } = require('./events');

let installed = false;
let originalHandle = null;

function isPublishIntent(text) {
  const value = String(text || '');
  return /\b(?:post|publish|schedule)\b/i.test(value)
    || /\bupload\b[\s\S]{0,80}\b(?:instagram|ig|buffer|social)\b/i.test(value)
    || /\b(?:instagram|ig|buffer|social)\b[\s\S]{0,80}\bupload\b/i.test(value);
}

function isReelRetrievalIntent(text) {
  let value = String(text || '').trim();
  if (!value || isPublishIntent(value)) return false;

  // Browser artifact normalization in older builds could turn
  // "attach the video" into "create attach the video". Treat the
  // accidental generation prefix as noise when an explicit retrieval
  // verb is present so local artifacts always win over generation APIs.
  value = value.replace(/^\s*(?:ultron[,:]?\s*)?(?:create|generate|make|produce)\s+(?=(?:please\s+)?(?:attach|send|show|give|open|download|share)\b)/i, '');

  const retrievalVerb = /\b(?:attach|send|show|give|open|download|share)\b/i.test(value);
  if (!retrievalVerb) return false;

  const reelArtifact = /\b(?:reel|instagram\s+video|video|mp4|clip)\b/i.test(value);
  const reference = /\b(?:last|latest|recent|previous|new|newest|revised|updated|current|final|finished|rendered)\b/i.test(value);
  const referentialOne = /\b(?:that|this|the)\s+(?:new\s+|latest\s+|revised\s+|updated\s+|final\s+)?(?:one|version)\b/i.test(value);

  // Explicit Reel/video delivery is enough. Referential "one/version"
  // requires a version marker to avoid hijacking unrelated attachments.
  return reelArtifact || (reference && referentialOne);
}

function responseFromLatest(text, options = {}) {
  const inputMode = String(options.inputMode || 'chat').toLowerCase() === 'voice' ? 'voice' : 'chat';
  conversation.append('user', String(text || '').trim(), { taskType: 'reel-factory-attachment', inputMode });
  const attached = reelOperator.attachLatestReelResponse();
  const artifacts = attached.artifact ? [attached.artifact] : [];

  conversation.append('assistant', attached.text, {
    model: 'reel-attachment-guard',
    provider: 'local',
    taskType: 'reel-factory-attachment',
    inputMode,
    ok: attached.ok,
    artifactId: attached.artifact?.id || null,
  });

  emit(attached.ok ? 'reel_factory_artifact_attached' : 'reel_factory_artifact_failed', {
    inputMode,
    artifactId: attached.artifact?.id || null,
    output: attached.result?.output?.path || null,
    error: attached.artifactError || null,
    retrievalGuard: true,
  });

  void voice.enqueue(attached.text);
  return {
    ok: attached.ok,
    response: attached.text,
    text: attached.text,
    model: 'reel-attachment-guard',
    provider: 'local',
    taskType: 'reel-factory-attachment',
    mode: 'operator-local-retrieval',
    inputMode,
    reel: attached.result,
    artifacts,
    error: attached.artifactError || null,
    toolRounds: 0,
    localRetrieval: true,
  };
}

function install() {
  if (installed) return status();
  if (typeof assistant.handle !== 'function') throw new Error('Assistant handle is unavailable for Reel Attachment Guard.');
  originalHandle = assistant.handle;
  assistant.handle = async (message, options = {}) => {
    if (isReelRetrievalIntent(message)) return responseFromLatest(message, options);
    return originalHandle(message, options);
  };
  installed = true;
  return status();
}

function uninstall() {
  if (!installed) return status();
  if (originalHandle) assistant.handle = originalHandle;
  originalHandle = null;
  installed = false;
  return status();
}

function status() {
  return { installed, localOnly: true, generationApiUsed: false, latestReelLookup: true };
}

module.exports = { isPublishIntent, isReelRetrievalIntent, responseFromLatest, install, uninstall, status };
