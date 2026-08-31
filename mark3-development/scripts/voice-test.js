const voice = require('../core/voice-orchestrator');
const sample = 'Hello. How are you? I am ready!';
const parts = voice.splitSpeech(sample);
if (parts.join(' ') !== sample) throw new Error('Voice segmentation changed speech content.');
if (voice.clean('Hello `code` https://example.com') !== 'Hello') throw new Error('Speech cleanup invariant failed.');
console.log(`Voice orchestration test passed: ${parts.length} sequential chunks.`);
