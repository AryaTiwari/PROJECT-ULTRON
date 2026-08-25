const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const N8N_WEBHOOK = 'http://localhost:5678/webhook-test/ultron';
const ROOT = __dirname;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function send(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/chat') {
    let raw = '';
    req.setEncoding('utf8');

    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 100_000) req.destroy();
    });

    req.on('end', async () => {
      try {
        const incoming = JSON.parse(raw || '{}');
        const message = String(incoming.message || '').trim();

        if (!message) {
          return send(res, 400, JSON.stringify({ error: 'Message is required.' }), 'application/json; charset=utf-8');
        }

        const upstream = await fetch(N8N_WEBHOOK, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message }),
        });

        const text = await upstream.text();
        const contentType = upstream.headers.get('content-type') || '';

        if (!upstream.ok) {
          return send(
            res,
            502,
            JSON.stringify({
              error: `n8n returned HTTP ${upstream.status}`,
              details: text.slice(0, 2000),
            }),
            'application/json; charset=utf-8'
          );
        }

        res.writeHead(200, {
          'Content-Type': contentType.includes('application/json')
            ? 'application/json; charset=utf-8'
            : 'text/plain; charset=utf-8',
        });
        return res.end(text);
      } catch (error) {
        return send(
          res,
          502,
          JSON.stringify({
            error: 'Could not reach the Ultron Core.',
            details: error.message,
          }),
          'application/json; charset=utf-8'
        );
      }
    });

    return;
  }

  // Serve the static interface.
  let requestPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (requestPath === '/') requestPath = '/index.html';

  const safePath = path.normalize(requestPath).replace(/^([.][.][/\\])+/, '');
  const filePath = path.join(ROOT, safePath);

  if (!filePath.startsWith(ROOT)) {
    return send(res, 403, 'Forbidden');
  }

  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return send(res, 404, 'Not found');

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    return send(res, 404, 'Not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`ULTRON interface: http://localhost:${PORT}`);
  console.log(`n8n core: ${N8N_WEBHOOK}`);
});
