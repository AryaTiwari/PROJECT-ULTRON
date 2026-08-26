const http = require('http');
const { loadDotEnv } = require('./env');
loadDotEnv();

const { UltronCore } = require('./ultron-core');

const PORT = Number(process.env.ULTRON_CORE_PORT || 8787);
const HOST = process.env.ULTRON_CORE_HOST || '127.0.0.1';
const ALLOWED_ORIGIN = process.env.ULTRON_UI_ORIGIN || 'http://localhost:3000';
const core = new UltronCore();

function send(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 100_000) reject(new Error('Request body too large.'));
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});

  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { ok: true, service: 'ultron-core', ...core.status() });
  }

  if (req.method === 'GET' && req.url === '/api/status') {
    return send(res, 200, core.status());
  }

  if (req.method === 'POST' && req.url === '/api/chat') {
    try {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        return send(res, 400, { ok: false, error: 'Request body must be valid JSON.' });
      }

      const message = String(body.message || '').trim();
      if (!message) return send(res, 400, { ok: false, error: 'Message is required.' });

      const result = await core.handleMessage(message, {
        conversationId: body.conversation_id || null,
        confirmed: body.confirmed === true,
      });
      return send(res, result.ok ? 200 : 409, result);
    } catch (error) {
      console.error('[ULTRON CORE]', error);
      return send(res, 500, { ok: false, error: error?.message || String(error) });
    }
  }

  return send(res, 404, { ok: false, error: 'Not found.' });
});

server.listen(PORT, HOST, () => {
  console.log(`ULTRON Core listening at http://${HOST}:${PORT}`);
  console.log(`Model gateway: ${process.env.OMNIROUTE_CHAT_URL || 'http://127.0.0.1:20128/v1/chat/completions'}`);
});
