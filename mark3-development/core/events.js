const listeners = new Set();
let sequence = 0;

function emit(type, payload = {}) {
  const event = { id: ++sequence, type, at: new Date().toISOString(), ...payload };
  for (const listener of listeners) {
    try { listener(event); } catch {}
  }
  return event;
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

module.exports = { emit, subscribe };
