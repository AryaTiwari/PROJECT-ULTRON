const { emit } = require('./events');
const workspace = require('./workspace');

let timer = null;
let lastFingerprint = '';

function fingerprint(items) { return items.map(item => `${item.id}:${item.status}:${item.dueAt || ''}:${item.missCount}`).join('|'); }
function evaluate() {
  const open = workspace.listCommitments({ status: 'open' });
  const overdue = open.filter(item => item.dueAt && Date.parse(item.dueAt) < Date.now());
  const key = fingerprint(overdue);
  if (key && key !== lastFingerprint) {
    lastFingerprint = key;
    emit('proactive_alert', { priority: overdue.some(item => item.priority === 'high') ? 3 : 2, reason: 'overdue_commitment', commitments: overdue });
  }
}
function start(intervalMs) { stop(); timer = setInterval(evaluate, intervalMs); evaluate(); }
function stop() { if (timer) clearInterval(timer); timer = null; }
module.exports = { start, stop, evaluate };
