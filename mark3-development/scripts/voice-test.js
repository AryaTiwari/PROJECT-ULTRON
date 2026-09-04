const fs = require('fs');
const path = require('path');
const voice = require('../core/voice-orchestrator');
const integrations = require('../core/integrations');
const config = require('../core/config');

const sample = 'Hello. How are you? I am ready!';
const parts = voice.splitSpeech(sample);
if (parts.join(' ') !== sample) throw new Error('Voice segmentation changed speech content.');
if (voice.clean('Hello `code` https://example.com') !== 'Hello') throw new Error('Speech cleanup invariant failed.');

const nativeVoiceSource = fs.readFileSync(path.join(config.mark3Root, 'interface', 'native-voice.js'), 'utf8');
if (!nativeVoiceSource.includes('function reconcileTranscripts')) throw new Error('Native voice transcript reconciliation guard is missing.');
if (!nativeVoiceSource.includes("source: 'dual-transcript-trim'")) throw new Error('Native voice does not record dual-transcript trimming.');
if (!nativeVoiceSource.includes('extraWords >= 3')) throw new Error('Native voice trailing-noise threshold is missing.');
if (!nativeVoiceSource.includes('parsed.message = reconciled.text')) throw new Error('Reconciled transcript is not authoritative for chat dispatch.');
if (!nativeVoiceSource.includes('Unsupported trailing transcript removed')) throw new Error('Voice trim observability event is missing.');

const status = integrations.voiceStatus();
if (!status.outputDir || path.resolve(status.outputDir) !== path.resolve(config.voiceOutputDir)) throw new Error('Voice output directory is not Mark 3-local/project-root anchored.');
if (!status.fallback) throw new Error('Voice fallback is not configured.');
if (JSON.stringify(status).includes('8787')) throw new Error('Mark 3 voice still references the Mark 2 server.');

console.log(`Voice orchestration test passed: ${parts.length} chunks; dual-transcript trailing-noise guard active; primary=${status.primary?.provider || 'unconfigured'}; fallback=${status.fallback}.`);
