const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const config = require('./config');

const STATE_FILE = path.join(config.projectRoot, '.ultron', 'approvals', 'paid-tools.json');
const TTL_MS = Math.max(5 * 60_000, Number(process.env.ULTRON_M3_PAID_APPROVAL_TTL_MS || 30 * 60_000));
const permitStore = new AsyncLocalStorage();

const TOOLS = {
  apollo: {
    label: 'Apollo',
    reason: 'credit-consuming office-owned lead-enrichment API',
    oneRunOnly: true,
  },
  tinyfish: {
    label: 'TinyFish Search',
    reason: 'external search API that may consume account quota',
    oneRunOnly: true,
  },
};

function load() {
  try {
    if (!fs.existsSync(STATE_FILE)) return { version: 1, pending: [], history: [] };
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      version: 1,
      pending: Array.isArray(parsed.pending) ? parsed.pending : [],
      history: Array.isArray(parsed.history) ? parsed.history : [],
    };
  } catch {
    return { version: 1, pending: [], history: [] };
  }
}

function save(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  state.pending = (state.pending || []).slice(-12);
  state.history = (state.history || []).slice(-80);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function fresh(item) {
  const at = Date.parse(item?.requestedAt || '');
  return Number.isFinite(at) && Date.now() - at <= TTL_MS;
}

function prune(state = load()) {
  const expired = [];
  const active = [];
  for (const item of state.pending || []) {
    if (fresh(item)) active.push(item);
    else expired.push({ ...item, status: 'expired', resolvedAt: new Date().toISOString() });
  }
  state.pending = active;
  if (expired.length) state.history.push(...expired);
  save(state);
  return state;
}

function definition(tool) {
  const key = String(tool || '').trim().toLowerCase();
  return { key, ...(TOOLS[key] || { label: key || 'Paid tool', reason: 'credit/quota-consuming external tool', oneRunOnly: true }) };
}

function request(tool, operation, payload = {}, summary = '') {
  const def = definition(tool);
  const state = prune();
  state.pending = state.pending.filter((item) => item.tool !== def.key);
  const item = {
    id: `approval-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    tool: def.key,
    label: def.label,
    reason: def.reason,
    operation: String(operation || 'run'),
    payload: payload && typeof payload === 'object' ? payload : {},
    summary: String(summary || '').trim(),
    status: 'pending',
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + TTL_MS).toISOString(),
  };
  state.pending.push(item);
  save(state);
  return item;
}

function pending(tool = null) {
  const state = prune();
  const key = tool ? definition(tool).key : null;
  const rows = key ? state.pending.filter((item) => item.tool === key) : state.pending;
  return rows[rows.length - 1] || null;
}

function allPending() {
  return prune().pending.slice();
}

function affirmative(text) {
  const value = String(text || '').trim().toLowerCase();
  return /^(?:yes|yep|yeah|ok|okay|approved?|allow(?: it)?|go ahead|proceed|use it|do it)(?:[.!\s]*)$/i.test(value)
    || /\b(?:approve|allow|yes\s+use|go\s+ahead\s+with|use)\b/i.test(value);
}

function negative(text) {
  return /^(?:no|nope|deny|denied|cancel|don'?t|do not|skip it|skip)(?:[.!\s]*)$/i.test(String(text || '').trim());
}

function referencedTool(text, item) {
  const value = String(text || '').toLowerCase();
  if (!item) return false;
  return value.includes(item.tool) || value.includes(String(item.label || '').toLowerCase());
}

function resolveMessage(text) {
  const state = prune();
  if (!state.pending.length) return null;
  const value = String(text || '').trim();
  if (!value) return null;

  let candidates = state.pending.filter((item) => referencedTool(value, item));
  if (!candidates.length && state.pending.length === 1 && (affirmative(value) || negative(value))) candidates = [state.pending[0]];
  if (candidates.length !== 1) return null;
  const item = candidates[0];

  let decision = null;
  if (negative(value)) decision = 'denied';
  else if (affirmative(value)) decision = 'approved';
  if (!decision) return null;

  state.pending = state.pending.filter((row) => row.id !== item.id);
  const resolved = { ...item, status: decision, resolvedAt: new Date().toISOString() };
  state.history.push(resolved);
  save(state);
  return resolved;
}

function prompt(item) {
  const def = definition(item?.tool);
  const detail = item?.summary ? ` ${item.summary}` : '';
  return `${def.label} requires approval before I use it, Sir. It is a ${def.reason}.${detail} Approve ${def.label} for this one run only? Nothing will be charged or queried until you approve.`;
}

function isPermitted(tool) {
  const store = permitStore.getStore();
  return Boolean(store?.tools?.has(definition(tool).key));
}

function assertPermitted(tool) {
  if (isPermitted(tool)) return true;
  const def = definition(tool);
  const error = new Error(`${def.label} is blocked until the user explicitly approves this run.`);
  error.code = 'PAID_TOOL_APPROVAL_REQUIRED';
  error.tool = def.key;
  throw error;
}

async function withPermit(approval, fn) {
  if (!approval || approval.status !== 'approved') throw new Error('A resolved paid-tool approval is required.');
  const tool = definition(approval.tool).key;
  const parent = permitStore.getStore();
  const tools = new Set(parent?.tools || []);
  tools.add(tool);
  return permitStore.run({ tools, approvalId: approval.id }, fn);
}

function installApolloGuard() {
  const apollo = require('./apollo-enrichment');
  if (apollo.__paidApprovalGuardInstalled) return;
  const originalEnrich = apollo.enrich.bind(apollo);
  apollo.enrich = async (...args) => {
    assertPermitted('apollo');
    return originalEnrich(...args);
  };
  apollo.__paidApprovalGuardInstalled = true;
}

function status() {
  return {
    ready: true,
    stateFile: STATE_FILE,
    ttlMs: TTL_MS,
    tools: TOOLS,
    pending: allPending().map((item) => ({ id: item.id, tool: item.tool, operation: item.operation, requestedAt: item.requestedAt, expiresAt: item.expiresAt })),
  };
}

module.exports = {
  TOOLS,
  STATE_FILE,
  request,
  pending,
  allPending,
  resolveMessage,
  prompt,
  isPermitted,
  assertPermitted,
  withPermit,
  installApolloGuard,
  status,
};
