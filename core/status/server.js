const http = require('http');
const { collectSystemStatus } = require('./system-status');

const host = process.env.ULTRON_STATUS_HOST || '127.0.0.1';
const port = Number(process.env.ULTRON_STATUS_PORT || 8789);

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, OPTIONS' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'Method not allowed.' });
  if (req.url === '/health') return json(res, 200, { ok: true, service: 'ultron-status', version: 'mark2' });
  if (req.url === '/api/status') {
    try { return json(res, 200, await collectSystemStatus()); }
    catch (error) { return json(res, 500, { ok: false, error: error?.message || String(error) }); }
  }
  return json(res, 404, { ok: false, error: 'Not found.' });
});

server.listen(port, host, () => console.log(`ULTRON Status API listening at http://${host}:${port}`));
