const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./core/config');
const assistant = require('./core/assistant');
const memory = require('./core/memory');
const workspace = require('./core/workspace');
const models = require('./core/model-intelligence');
const integrations = require('./core/integrations');
const { subscribe } = require('./core/events');
const proactive = require('./core/proactive');

const webRoot = path.join(config.root, 'interface');
const sseClients = new Set();
subscribe(event => { for (const res of sseClients) { try { res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); } catch {} } });
proactive.start(config.proactiveIntervalMs);

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(payload), 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
  res.end(payload);
}
function body(req) { return new Promise((resolve, reject) => { let raw=''; req.setEncoding('utf8'); req.on('data', c => { raw += c; if (raw.length > 200000) reject(new Error('Request too large.')); }); req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (e) { reject(new Error('Invalid JSON request.')); } }); req.on('error', reject); }); }
function safePath(urlPath) { const clean = decodeURIComponent(new URL(urlPath, 'http://127.0.0.1').pathname).replace(/^\/+/, '') || 'index.html'; const file = path.resolve(webRoot, clean); return file.startsWith(webRoot + path.sep) ? file : null; }
function serve(req,res) { const file = safePath(req.url || '/'); const target = file && fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(webRoot,'index.html'); if (!fs.existsSync(target)) return send(res,404,{ok:false,error:'Interface not built.'},'application/json; charset=utf-8'); const ext=path.extname(target).toLowerCase(); const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.json':'application/json; charset=utf-8'}; const stat=fs.statSync(target); res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Content-Length':stat.size,'Cache-Control':ext==='.js'||ext==='.css'?'no-cache':'no-store'}); fs.createReadStream(target).pipe(res); }

const server = http.createServer(async (req,res)=>{
  try {
    if(req.method==='OPTIONS') return send(res,204,'');
    if(req.method==='GET' && req.url==='/api/health') {
      const router = await integrations.health();
      return send(res,200,{ok:Boolean(router.ok),service:'ULTRON Mark 3',version:'3.0.0-beta.3',inference:{mode:router.ok?'omniroute':'unavailable',openCodeDisabled:true,omniRouteDisabled:false,directProviders:{}},pid:process.pid,port:config.port});
    }
    if(req.method==='GET' && req.url==='/api/state') return send(res,200,{ok:true,memory:memory.snapshot(),commitments:workspace.listCommitments({status:'open'}),projects:workspace.listProjects(),decisions:workspace.listDecisions()});
    if(req.method==='GET' && req.url==='/api/models') return send(res,200,{ok:true,...(await models.intelligence())});
    if(req.method==='GET' && req.url==='/api/diagnostics/omniroute') {
      let catalog = null; let error = null;
      try { catalog = await models.catalog(); } catch (e) { error = e instanceof Error ? e.message : String(e); }
      return send(res,200,{ok:Boolean(catalog && catalog.count >= 0),endpoint:config.omnirouteBase,parentRouterLoaded:Boolean(catalog || error),catalog,error,credential:{envConfigured:Boolean(config.omnirouteEndpointKey),resolved:Boolean(await integrations.resolveOmniRouteApiKey())},inferenceDisabled:false});
    }
    if(req.method==='GET' && req.url==='/api/events') { res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','Access-Control-Allow-Origin':'*','X-Accel-Buffering':'no'}); res.write('event: connected\ndata:{"ok":true}\n\n'); sseClients.add(res); req.on('close',()=>sseClients.delete(res)); return; }
    if(req.method==='POST' && req.url==='/api/chat'){ const data=await body(req); const result=await assistant.handle(data.message,{model:data.model,history:data.history,taskType:data.taskType}); return send(res,200,result); }
    if(req.method==='POST' && req.url==='/api/memory'){ const data=await body(req); return send(res,200,{ok:true,result:memory.remember(data)}); }
    if(req.method==='POST' && req.url==='/api/commitments'){ const data=await body(req); return send(res,200,{ok:true,commitment:workspace.createCommitment(data)}); }
    if(req.method==='POST' && req.url==='/api/decisions'){ const data=await body(req); return send(res,200,{ok:true,decision:workspace.recordDecision(data)}); }
    if(req.method==='POST' && req.url==='/api/projects'){ const data=await body(req); return send(res,200,{ok:true,project:workspace.upsertProject(data)}); }
    if(req.method==='GET') return serve(req,res);
    return send(res,404,{ok:false,error:'Not found.'});
  } catch(error) { return send(res,500,{ok:false,error:error.message}); }
});
server.listen(config.port,config.host,()=>console.log(`ULTRON Mark 3 listening at http://${config.host}:${config.port} [PID ${process.pid}]`));
