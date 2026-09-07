// Loaded only by the Mark 3 server process. Forge installs lightweight local
// read-only endpoints before server.js creates its HTTP server, then Context Fabric,
// Turbo, Operator Mode, Reel Intelligence, Reel Factory, Forge and Adaptive Intelligence
// wrap the normal assistant in a deliberate order.
const http = require('http');

function json(res, data, status = 200) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(payload);
}

const originalCreateServer = http.createServer.bind(http);
http.createServer = (...args) => {
  const listenerIndex = args.findLastIndex((value) => typeof value === 'function');
  if (listenerIndex < 0) return originalCreateServer(...args);
  const normalListener = args[listenerIndex];
  args[listenerIndex] = async (req, res) => {
    try {
      const parsed = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = parsed.pathname;
      if (req.method === 'GET' && pathname === '/api/context/fabric') {
        return json(res, { ok: true, ...require('../context-fabric').compactSnapshot() });
      }
      if (req.method === 'GET' && pathname === '/api/conversation/history') {
        const limit = Math.max(1, Math.min(500, Number(parsed.searchParams.get('limit') || 120)));
        return json(res, { ok: true, messages: require('../conversation').history(limit) });
      }
      if (req.method === 'GET' && pathname === '/api/conversation/sessions') {
        const limit = Math.max(1, Math.min(50, Number(parsed.searchParams.get('limit') || 12)));
        return json(res, { ok: true, sessions: require('../conversation').sessions(limit) });
      }
      if (req.method === 'GET' && pathname === '/api/conversation/session') {
        const id = String(parsed.searchParams.get('id') || '').trim();
        if (!id) return json(res, { ok: false, error: 'session id is required' }, 400);
        return json(res, { ok: true, id, messages: require('../conversation').sessionHistory(id, 160) });
      }
      if (req.method === 'GET' && pathname === '/api/forge/status') {
        return json(res, require('./dashboard').payload());
      }
      if (req.method === 'GET' && pathname === '/api/turbo/status') {
        return json(res, require('../turbo-engine').audit());
      }
      if (req.method === 'GET' && ['/forge', '/forge/', '/forge-dashboard'].includes(pathname)) {
        const payload = require('./dashboard').page();
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(payload),
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(payload);
        return;
      }
    } catch (error) {
      if (!res.headersSent) return json(res, { ok: false, error: error.message }, 500);
    }
    return normalListener(req, res);
  };
  return originalCreateServer(...args);
};

setImmediate(async () => {
  try {
    const context = require('../context-fabric-runtime').install();
    console.log(`[Mark 3] Context Fabric ready; timezone=${context.timezone}, persistent history=${context.persistentHistory ? 'on' : 'off'}, contextual greetings=${context.contextualGreetings ? 'on' : 'off'}.`);
  } catch (error) {
    console.error(`[Mark 3] Context Fabric bootstrap failed: ${error.message}`);
  }

  try {
    const turbo = require('../turbo-bootstrap').install();
    const fallbacks = turbo.research?.searchFallbacks?.join(', ') || 'none configured';
    console.log(`[Mark 3] Turbo Engine ready; zero-cost research fallbacks=${fallbacks}. Health API: http://127.0.0.1:8790/api/turbo/status`);
  } catch (error) {
    console.error(`[Mark 3] Turbo Engine bootstrap failed: ${error.message}`);
  }

  try {
    const operator = require('../operator-bootstrap').install();
    console.log(`[Mark 3] Operator Mode ready; ${operator.status.ready.length} capability/capabilities executable now.`);
  } catch (error) {
    console.error(`[Mark 3] Operator Mode bootstrap failed: ${error.message}`);
  }

  try {
    const intel = require('../reel-intelligence-runtime').install();
    console.log(`[Mark 3] Reel Intelligence ready; trend=${intel.status.trendMode || 'refresh-on-demand'}, adaptive account-fit enabled.`);
  } catch (error) {
    console.error(`[Mark 3] Reel Intelligence bootstrap failed: ${error.message}`);
  }

  try {
    require('../reel-v2-runtime').install();
    console.log('[Mark 3] Reel Factory v2 premium finisher + final quality gate ready.');
  } catch (error) {
    console.error(`[Mark 3] Reel Factory v2 finishing bootstrap failed: ${error.message}`);
  }

  try {
    const reels = require('../reel-operator-bootstrap').install();
    const ready = reels.status.stockSourceReady && reels.status.ffmpeg.available;
    console.log(`[Mark 3] Reel Factory Operator ${ready ? 'ready' : 'installed with blocker'}; natural make-a-reel commands enabled.`);
  } catch (error) {
    console.error(`[Mark 3] Reel Factory bootstrap failed: ${error.message}`);
  }

  try {
    const result = require('./bootstrap').install();
    console.log(`[Mark 3] ULTRON Forge ready${result.recovered?.length ? `; recovered ${result.recovered.length} mission(s)` : ''}. Command Center: http://127.0.0.1:8790/forge`);
  } catch (error) {
    console.error(`[Mark 3] ULTRON Forge bootstrap failed: ${error.message}`);
  }

  // Adaptive installs last so it can observe the final behavior of every upstream
  // runtime wrapper without changing their execution/approval semantics.
  try {
    const adaptive = require('../adaptive-bootstrap').install();
    console.log(`[Mark 3] Adaptive Intelligence ready; ${adaptive.status.totalObservations || 0} learned observation(s), approval-gated proposals enabled.`);
  } catch (error) {
    console.error(`[Mark 3] Adaptive Intelligence bootstrap failed: ${error.message}`);
  }

  try {
    const coach = require('../system-coach').start();
    console.log(`[Mark 3] System Coach online; diagnostics interval=${Math.round(coach.intervalMs / 60000)}m, low-noise suggestions enabled.`);
  } catch (error) {
    console.error(`[Mark 3] System Coach bootstrap failed: ${error.message}`);
  }

  // Telegram remains implemented but intentionally dormant until the founder chooses
  // to enroll/pair it. Do not start remote polling just because credentials exist.
  try {
    const telegram = require('../telegram-remote').status();
    if (telegram.tokenConfigured || telegram.allowedChatConfigured) {
      console.log('[Mark 3] Telegram Remote is installed but enrollment is paused; no polling process was started.');
    }
  } catch {}
});
