const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const config = require('./config');
const events = require('./events');
const context = new AsyncLocalStorage();
const root = path.join(config.projectRoot, '.ultron', 'linkedin-missions');
let running = false;
let executor;
const queue = [];

function file(id) {
  if (!/^[a-z0-9-]+$/i.test(id)) throw new Error('Invalid mission ID');
  return path.join(root, `${id}.json`);
}
function get(id) { return JSON.parse(fs.readFileSync(file(id), 'utf8')); }
function save(mission, preserveControl = true) {
  fs.mkdirSync(root, { recursive: true });
  mission.updatedAt = new Date().toISOString();
  const target = file(mission.id);
  if (preserveControl && fs.existsSync(target)) mission.control = get(mission.id).control || null;
  fs.writeFileSync(`${target}.tmp`, JSON.stringify(mission));
  fs.renameSync(`${target}.tmp`, target);
  events.emit('linkedin:progress', summary(mission));
}
function summary(m) {
  return { id: m.id, status: m.status, updatedAt: m.updatedAt, calls: m.calls || 0,
    cacheHits: m.cacheHits || 0, error: m.error || null, result: m.result || null };
}
function list() {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter(n => n.endsWith('.json')).map(n => get(n.slice(0, -5)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
function start(fn) {
  executor = fn;
  for (const m of list()) {
    if (['created', 'searching', 'writing_sheet'].includes(m.status)) {
      // Never replay possibly committed Sheet writes automatically.
      m.status = 'paused_restart';
      save(m);
    }
  }
}
function enqueue(prepared) {
  if (queue.length >= 20) throw new Error('LINKEDIN_QUEUE_FULL');
  const m = { id: randomUUID(), createdAt: new Date().toISOString(), status: 'created',
    prepared, calls: 0, cacheHits: 0, responses: {}, research: null };
  save(m);
  queue.push(m.id);
  setImmediate(pump);
  return summary(m);
}
async function pump() {
  if (running || !executor || !queue.length) return;
  running = true;
  const m = get(queue.shift());
  try {
    if (m.status !== 'created') return;
    m.status = 'searching'; save(m);
    const result = await context.run(m, () => executor(m.prepared));
    m.result = result;
    const mission = result?.linkedinMission;
    m.status = /COOLDOWN|CAP|RATE_LIMIT/.test(m.stopCode || '') ? 'paused_rate_limit'
      : mission && (mission.budgetStopped || mission.found < mission.requested) ? 'partial' : 'completed';
    save(m);
    events.emit('linkedin:complete', summary(m));
  } catch (error) {
    const code = String(error.code || error.message || 'LINKEDIN_MISSION_FAILED');
    m.error = { code, message: String(error.message || code) };
    m.status = /CHECKPOINT|MANUAL_LOCK/.test(code) ? 'paused_checkpoint'
      : /COOLDOWN|CAP|RATE_LIMIT/.test(code) ? 'paused_rate_limit'
        : code === 'LINKEDIN_MISSION_PAUSED' ? 'paused' : code === 'LINKEDIN_MISSION_CANCELLED' ? 'cancelled' : 'failed';
    save(m);
  } finally { running = false; setImmediate(pump); }
}
function check() {
  const m = context.getStore();
  if (!m) return;
  const persisted = get(m.id);
  if (persisted.control) {
    const error = new Error(`LINKEDIN_MISSION_${persisted.control === 'cancel' ? 'CANCELLED' : 'PAUSED'}`);
    error.code = error.message; throw error;
  }
}
async function call(tool, args, invoke) {
  const m = context.getStore();
  if (!m) return invoke();
  check();
  const key = JSON.stringify([tool, args]);
  if (m.responses[key] && Date.now() - m.responses[key].at < 60 * 60 * 1000) {
    m.cacheHits++; save(m); return m.responses[key].value;
  }
  let value;
  try { value = await invoke(); }
  catch (error) { m.stopCode = String(error.code || ''); save(m); throw error; }
  m.responses[key] = { at: Date.now(), value };
  m.calls++; save(m); return value;
}
function persistResearch(research) {
  const m = context.getStore();
  if (!m) return;
  check(); m.research = research; m.status = 'writing_sheet'; save(m);
}
function control(id, action) {
  const m = get(id);
  if (action === 'resume') {
    if (!['paused', 'paused_restart', 'paused_checkpoint', 'paused_rate_limit', 'failed', 'partial'].includes(m.status)) throw new Error('Mission is not resumable');
    if (m.research) throw new Error('Research is preserved; inspect the existing Sheet before retrying output to avoid duplicate writes.');
    m.control = null; m.status = 'created'; save(m, false); queue.push(id); setImmediate(pump);
  } else {
    m.control = action === 'cancel' ? 'cancel' : 'pause'; save(m, false);
  }
  return summary(m);
}
module.exports = { start, enqueue, get, list, summary, control, call, persistResearch };
