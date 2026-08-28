const assert = require('node:assert/strict');

const BASE_URL = process.env.ULTRON_CORE_URL || 'http://127.0.0.1:8787';

async function main() {
  const response = await fetch(`${BASE_URL}/api/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({
      message: 'Reply briefly with exactly: ULTRON STREAM ONLINE',
      source: 'stream-smoke-test',
    }),
  });

  assert.equal(response.ok, true, `stream endpoint returned HTTP ${response.status}`);
  assert.ok(response.body, 'stream endpoint returned no response body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sawMeta = false;
  let sawDelta = false;
  let sawFinal = false;
  let streamedText = '';
  let finalResult = null;

  const consume = (block) => {
    const lines = block.replace(/\r/g, '').split('\n');
    let eventType = 'message';
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith('event:')) eventType = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) return;
    let payload = {};
    try { payload = JSON.parse(dataLines.join('\n')); } catch { return; }
    const type = payload.type || eventType;
    if (type === 'meta') sawMeta = true;
    if (type === 'delta') { sawDelta = true; streamedText += String(payload.text || ''); }
    if (type === 'final') { sawFinal = true; finalResult = payload.result || payload; }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      consume(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) consume(buffer);

  assert.equal(sawMeta, true, 'stream never emitted meta event');
  assert.equal(sawDelta, true, 'stream never emitted delta event');
  assert.equal(sawFinal, true, 'stream never emitted final event');
  assert.ok(streamedText.trim(), 'stream emitted empty text');
  assert.equal(String(finalResult?.response || '').trim(), streamedText.trim(), 'final response does not match streamed text');

  console.log(JSON.stringify({
    ok: true,
    endpoint: `${BASE_URL}/api/chat/stream`,
    streamed_chars: streamedText.length,
    final_model: finalResult?.model || null,
    response: finalResult?.response || streamedText,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
});
