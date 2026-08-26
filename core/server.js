const http = require('http');
const { UltronCore } = require('./ultron-core');
const { config } = require('./config');
const { snapshot } = require('./inspector');

const core = new UltronCore();

function send(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

  if (req.method === 'GET' && req.url === '/api/tools') {
    return send(res, 200, { ok: true, tools: require('./executor').listTools() });
  }

  if (req.method === 'GET' && req.url === '/api/inspect') {
    try {
      return send(res, 200, { ok: true, ...(await snapshot(core)) });
    } catch (error) {
      return send(res, 500, { ok: false, error: error?.message || String(error) });
    }
  }

  if (req.method === 'POST' && req.url === '/api/chat') {
    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw || '{}');
      const result = await core.handleMessage(body.message, {
        confirmed: body.confirmed === true,
        model: body.model,
        action: body.action || null,
      });
      return send(res, result.ok ? 200 : 502, result);
    } catch (error) {
      return send(res, 500, { ok: false, error: error?.message || String(error) });
    }
  }

  return send(res, 404, { ok: false, error: 'Not found.' });
});

server.listen(config.port, config.host, () => {
  console.log(`ULTRON Core listening at http://${config.host}:${config.port}`);
});
