const fs = require('fs');
const path = require('path');
const { createPdf, createDocx } = require('../core/document-renderer');
const { readZipEntry } = require('../core/archive');
const multimodal = require('../core/multimodal');

const root = path.resolve(__dirname, '..');
function assert(condition, message) { if (!condition) throw new Error(message); }

const pdf = createPdf('# Test Report\n\nA concise ULTRON report.\n\n- First point\n- Second point', 'Self Test');
assert(Buffer.isBuffer(pdf) && pdf.subarray(0, 8).toString('ascii').startsWith('%PDF-1.4'), 'Local PDF renderer did not produce a PDF.');
assert(pdf.length > 400, 'Generated PDF is unexpectedly small.');

const docx = createDocx('# Test Document\n\nULTRON multimodal self test.', 'Self Test');
assert(Buffer.isBuffer(docx) && docx.length > 500, 'Local DOCX renderer did not produce an archive.');
const documentXml = readZipEntry(docx, 'word/document.xml');
assert(documentXml && /ULTRON multimodal self test/.test(documentXml.toString('utf8')), 'DOCX archive does not contain expected document text.');

assert(multimodal.generationIntent('Ultron generate an image of a futuristic creator dashboard')?.kind === 'image', 'Image generation intent was not detected.');
assert(multimodal.generationIntent('Ultron make a short video of a neon city')?.kind === 'video', 'Video generation intent was not detected.');
assert(multimodal.generationIntent('Ultron create a PDF report about Elevate OS')?.kind === 'pdf', 'PDF generation intent was not detected.');
assert(multimodal.generationIntent('Ultron send me a PDF with 20 fitness brands')?.kind === 'pdf', 'Natural send-me PDF requests must route on the server.');
assert(multimodal.generationIntent('Could you give me a PDF version of this?')?.kind === 'pdf', 'Polite give-me PDF requests must route on the server.');
assert(multimodal.generationIntent('Ultron make a Word document proposal')?.kind === 'docx', 'DOCX generation intent was not detected.');
assert(multimodal.generationIntent('Tell me what a PDF is') === null, 'Informational PDF questions must not accidentally generate files.');

const index = fs.readFileSync(path.join(root, 'interface', 'index.html'), 'utf8');
const chatTransport = fs.readFileSync(path.join(root, 'interface', 'chat-transport.js'), 'utf8');
const nativeVoice = fs.readFileSync(path.join(root, 'interface', 'native-voice.js'), 'utf8');
const nativeVoiceInput = fs.readFileSync(path.join(root, 'core', 'native-voice-input.js'), 'utf8');
const multimodalSource = fs.readFileSync(path.join(root, 'core', 'multimodal.js'), 'utf8');
const uploadUi = fs.readFileSync(path.join(root, 'interface', 'multimodal-ui.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

const transportIndex = index.indexOf('chat-transport.js');
const appIndex = index.indexOf('app.js');
const voiceIndex = index.indexOf('native-voice.js');
const filesIndex = index.indexOf('multimodal-ui.js');
assert(/multimodal\.css/.test(index), 'Multimodal interface stylesheet is not loaded.');
assert(transportIndex >= 0 && appIndex > transportIndex && voiceIndex > appIndex && filesIndex > voiceIndex, 'Chat transport, native voice and attachment wrappers must load in the intended fetch-chain order.');

assert(/normalizeArtifactMessage/.test(chatTransport), 'Natural artifact-request normalization is missing from chat transport.');
assert(/send\\s\+me/.test(chatTransport) && /give\\s\+me/.test(chatTransport), 'Natural send/give artifact commands are not normalized into generation requests.');
assert(/originalMessage/.test(chatTransport), 'Artifact normalization should preserve the original user wording for provenance.');
assert(!/sandbox:\/\/mnt\/data/.test(chatTransport), 'Chat transport must never introduce ChatGPT sandbox artifact links.');

assert(/MediaRecorder/.test(nativeVoice) && /\/api\/voice\/transcribe/.test(nativeVoice), 'Native audio capture/transcription bridge is missing.');
assert(/new MediaRecorder\(state\.stream/.test(nativeVoice) && /recorder\.start\(\)/.test(nativeVoice), 'Each native voice command must start a fresh standalone media recording.');
assert(!/preRoll/.test(nativeVoice), 'Rolling WebM pre-roll fragments must not return; they can create invalid standalone media files.');
assert(/browserTranscript/.test(nativeVoice), 'Browser transcription fallback/provenance is missing.');
assert(/permissions\.query/.test(nativeVoice), 'Already-granted microphone permission should warm native audio capture automatically.');
assert(!/transcription catalog HTTP/.test(nativeVoiceInput), 'OmniRoute STT must not probe the POST-only transcription endpoint with GET.');
assert(/omniTranscriptionModel/.test(nativeVoiceInput) && /method:\s*'POST'/.test(nativeVoiceInput), 'OmniRoute STT fallback must use a configured model and POST audio directly.');

assert(/integrations\.chat\(messages, 'auto\/best-reasoning'/.test(multimodalSource), 'Document composition must use the normal Mark 3 router.');
assert(!/omniRoute\.chat\(/.test(multimodalSource), 'Document composition must not bypass direct providers with a hard-wired OmniRoute chat call.');
assert(/direct-provider-content \+ local-renderer; omniroute-fallback-only/.test(multimodalSource), 'Document status must expose direct-provider-first composition.');

assert(/\/api\/files\/upload/.test(uploadUi) && /attachments/.test(uploadUi), 'Attachment upload/chat wiring is missing.');
assert(/artifacts/.test(uploadUi) && /artifact-card/.test(uploadUi), 'Generated artifact rendering is missing.');
assert(/OPEN \/ SAVE FILE/.test(uploadUi) && /\/api\/files\/download/.test(uploadUi), 'Generated artifacts must expose a real clickable local download link.');

for (const route of ['/api/files/upload','/api/files/read','/api/files/download','/api/media/generate','/api/voice/transcribe']) {
  assert(server.includes(route), `Server route missing: ${route}`);
}
assert(/ULTRON_M3_LEAGUE_ARENA_ENABLED\s*\|\|\s*['"]0['"]/.test(server), 'Background Model Arena must remain opt-in so idle ULTRON does not spend API quota.');
assert(/native-audio-multimodal-flow/.test(server), 'Server must expose the native-audio multimodal interface mode.');
assert(/3\.0\.0-beta\.22/.test(server), 'Server runtime version must be beta.22.');

console.log('ULTRON multimodal self-test passed: direct-first PDF/DOCX generation, server-side natural artifact routing, clickable downloads, valid native-audio containers, POST-only STT fallback, attachments and quota-safe passive Model League validated.');
