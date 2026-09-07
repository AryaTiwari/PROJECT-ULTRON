const contextFabric = require('./context-fabric');
const { emit } = require('./events');

let timer = null;
let lastFingerprint = '';
let lastEmittedAt = 0;
const INTERVAL_MS = Math.max(120000, Number(process.env.ULTRON_M3_SYSTEM_COACH_INTERVAL_MS || 5 * 60 * 1000));
const REPEAT_MS = Math.max(15 * 60 * 1000, Number(process.env.ULTRON_M3_SYSTEM_COACH_REPEAT_MS || 90 * 60 * 1000));

function fingerprint(value = {}) {
  return [value?.health?.state || '', value?.diagnostic?.level || '', value?.diagnostic?.source || '', value?.diagnostic?.text || '', value?.topAction?.id || value?.topAction?.title || ''].join('|');
}

function evaluate(options = {}) {
  const snapshot = contextFabric.compactSnapshot();
  const key = fingerprint(snapshot);
  const changed = key && key !== lastFingerprint;
  const oldEnough = Date.now() - lastEmittedAt >= REPEAT_MS;
  const meaningful = snapshot.diagnostic && snapshot.diagnostic.level !== 'stable';
  if (meaningful && (changed || oldEnough || options.force)) {
    lastFingerprint = key;
    lastEmittedAt = Date.now();
    emit('system_coach_suggestion', {
      priority: snapshot.diagnostic.level === 'critical' ? 3 : 1,
      reason: snapshot.diagnostic.source,
      message: snapshot.diagnostic.text,
      health: snapshot.health,
      topAction: snapshot.topAction || null,
    });
    return { emitted: true, snapshot };
  }
  lastFingerprint = key || lastFingerprint;
  return { emitted: false, snapshot };
}

function start() {
  if (timer) return status();
  try { evaluate({ force: false }); } catch {}
  timer = setInterval(() => { try { evaluate(); } catch {} }, INTERVAL_MS);
  timer.unref?.();
  return status();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  return status();
}

function status() {
  return { running: Boolean(timer), intervalMs: INTERVAL_MS, repeatMs: REPEAT_MS, lastEmittedAt: lastEmittedAt || null, lowNoise: true };
}

module.exports = { evaluate, start, stop, status };
