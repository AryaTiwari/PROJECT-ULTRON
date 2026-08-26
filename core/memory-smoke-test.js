const assert = require('assert');
const { judge } = require('./memory/judge');

(async () => {
  const existing = [
    { content: 'My father is Pawan', active: true },
    { content: 'Arya is building Project Ultron', active: true },
  ];

  const exact = await judge({ content: 'My father is Pawan' }, existing);
  const normalized = await judge({ content: 'MY FATHER IS PAWAN!!!' }, existing);
  const newMemory = await judge({ content: 'My sister is Angel' }, existing);

  assert.equal(exact.decision, 'IGNORE');
  assert.equal(normalized.decision, 'IGNORE');
  assert.equal(newMemory.decision, 'SAVE');

  console.log(JSON.stringify({ ok: true, exact, normalized, newMemory }, null, 2));
})().catch(error => {
  console.error(error);
  process.exit(1);
});
