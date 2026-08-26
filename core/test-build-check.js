const assert = require('assert');
const { judge } = require('./memory/judge');
const { retrieve } = require('./memory/retriever');
const { WAKE_WORD, detect, extractCommand } = require('./voice/wake-word');
const { parseToolIntent } = require('./mark2-runtime');
const { listTools } = require('./executor');

async function main() {
  const memories = [{ content: 'My father is Pawan', active: true }, { content: 'Arya is building Project Ultron', active: true }];
  const duplicate = await judge({ content: 'MY FATHER IS PAWAN!!!' }, memories);
  assert.equal(duplicate.decision, 'IGNORE');
  assert.equal(retrieve('What is my father name?', memories, 1)[0].content, 'My father is Pawan');
  assert.equal(WAKE_WORD, 'ULTRON');
  assert.equal(detect('ULTRON'), true);
  assert.equal(detect('ULTRON open the browser'), true);
  assert.equal(detect('HEY ULTRON'), false);
  assert.equal(extractCommand('ULTRON open the browser'), 'OPEN THE BROWSER');
  assert.equal(parseToolIntent('open https://example.com').name, 'open_url');
  assert.equal(parseToolIntent('system info').name, 'system_info');
  assert.ok(listTools().length >= 6);
  console.log(JSON.stringify({ ok: true, registered_tools: listTools().map(t => t.name), wake_word: WAKE_WORD }, null, 2));
}

main().catch(error => { console.error(error); process.exit(1); });
