const assert = require('assert');
const { judge } = require('./memory/judge');
const { retrieve } = require('./memory/retriever');

(async () => {
  const existing = [
    { content: 'My father is Pawan', active: true },
    { content: 'Arya is building Project Ultron', active: true },
  ];

  const exact = await judge({ content: 'My father is Pawan' }, existing);
  const normalized = await judge({ content: 'MY FATHER IS PAWAN!!!' }, existing);
  const newMemory = await judge({ content: 'My sister is Angel' }, existing);
  const nearDuplicate = await judge({ content: 'Pawan is my father' }, existing);
  const relevant = retrieve('What is my father name?', existing, 3);

  assert.equal(exact.decision, 'IGNORE');
  assert.equal(normalized.decision, 'IGNORE');
  assert.equal(newMemory.decision, 'SAVE');
  assert.ok(['IGNORE', 'REVIEW'].includes(nearDuplicate.decision));
  assert.equal(relevant[0].content, 'My father is Pawan');

  console.log(JSON.stringify({ ok: true, exact, normalized, newMemory, nearDuplicate, relevant }, null, 2));
})().catch(error => {
  console.error(error);
  process.exit(1);
});
