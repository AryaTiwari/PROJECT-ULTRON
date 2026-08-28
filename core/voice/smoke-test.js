const assert = require('assert');
const fs = require('fs');
const voice = require('./index');
const { config } = require('./config');

assert.equal(voice.WAKE_WORD, 'ULTRON');
assert.equal(voice.detectWakeWord('ULTRON'), true);
assert.equal(voice.detectWakeWord('ULTRON what is the weather?'), true);
assert.equal(voice.detectWakeWord('HEY ULTRON'), false);
assert.equal(voice.detectWakeWord('OKAY ULTRON'), false);
assert.equal(voice.extractCommand('ULTRON open GitHub'), 'OPEN GITHUB');

const status = voice.status();
assert.equal(status.wakeWord, 'ULTRON');
assert.equal(status.wakeWordPolicy, 'exact-first-word-only');
assert.ok(['nvidia-magpie-zeroshot', 'fish-audio-s2.1-pro-free', 'local-chatterbox'].includes(config.provider));
assert.ok(fs.existsSync(config.referencePath), `Missing voice reference: ${config.referencePath}`);

console.log(JSON.stringify({
  ok: true,
  wakeWord: voice.WAKE_WORD,
  provider: config.provider,
  model: config.model,
  referenceExists: true,
  referencePath: config.referencePath,
  status,
}, null, 2));
