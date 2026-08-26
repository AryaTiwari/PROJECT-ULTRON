const assert = require('assert');
const { judge } = require('./judge');
const { shouldSupersede } = require('./update-policy');

(async () => {
  const existing = [
    { id: '1', content: 'My father is Pawan', memory_type: 'fact', confidence: 0.8, active: true },
    { id: '2', content: 'I am building Project Ultron', memory_type: 'fact', confidence: 0.8, active: true },
  ];
  assert.equal((await judge({ content: 'My father is Pawan' }, existing)).decision, 'IGNORE');
  assert.equal((await judge({ content: 'MY FATHER IS PAWAN!!!' }, existing)).decision, 'IGNORE');
  assert.equal((await judge({ content: 'My sister is Angel' }, existing)).decision, 'SAVE');
  assert.equal(shouldSupersede({ type: 'fact', content: 'My father is Raj', confidence: 0.9 }, existing[0]), true);
  console.log(JSON.stringify({ ok: true, duplicatePrevention: true, supersessionPolicy: true }, null, 2));
})().catch(error => { console.error(error); process.exit(1); });
