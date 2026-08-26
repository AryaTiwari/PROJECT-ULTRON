const assert = require('assert');
const voice = require('./index');

assert.equal(voice.WAKE_WORD, 'ULTRON');
assert.equal(voice.detectWakeWord('ULTRON'), true);
assert.equal(voice.detectWakeWord('ULTRON what is the weather?'), true);
assert.equal(voice.detectWakeWord('HEY ULTRON'), false);
assert.equal(voice.detectWakeWord('OKAY ULTRON'), false);
assert.equal(voice.extractCommand('ULTRON open GitHub'), 'OPEN GITHUB');

const status = voice.status();
assert.equal(status.wakeWord, 'ULTRON');
assert.equal(status.wakeWordPolicy, 'exact-first-word-only');

console.log(JSON.stringify({ ok: true, wakeWord: voice.WAKE_WORD, status }, null, 2));
