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
};

function load() {
  try {
    if (!fs.existsSync(STATE_FILE)) return { version: 2, pending: [], history: [] };
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      version: 2,
      pending: Array.isArray(parsed.pending) ? parsed.pending : [],
      history: Array.isArray(parsed.history) ? parsed.history : [],
    };
  } catch {
    return { version: 2, pending: [], history: [] };
  }
}

function save(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  state.version = 2;
  state.pending = (state.pending || []).slice(-12);
  state.history = (state.history || []).slice(-80);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function fresh(item) {
  const at = Date.parse(item?.requestedAt || '');
  return Number.isFinite(at) && Date.now() - at <= TTL_MS;
}

function prune(state = load()) {
  const retired = [];
  const active = [];
  for (const item of state.pending || []) {
    if (String(item?.tool || '').toLowerCase() !== 'apollo') {
      retired.push({ ...item, status: 'retired-non-apollo-gate', resolvedAt: new Date().toISOString() });
      continue;
    }
    if (fresh(item)) active.push(item);
    else retired.push({ ...item, status: 'expired', resolvedAt: new Date().toISOString() });
  }
  state.pending = active;
  if (retired.length) state.history.push(...retired);
  save(state);
  return state;
}

function definition(tool) {
  const key = String(tool || '').trim().toLowerCase();
  return { key, ...(TOOLS[key] || { label: key || 'Tool', reason: 'external tool', oneRunOnly: false }) };
}

function request(tool, operation, payload = {}, summary = '') {
  const def = definition(tool);
  if (def.key !== 'apollo') {
    const error = new Error(`${def.label} does not require ULTRON paid-tool approval. Only Apollo is approval-gated.`);
    error.code = 'NON_APOLLO_APPROVAL_DISABLED';
    throw error;
  }
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

function negative(text) {
  return /^(?:no|nope|deny|denied|cancel|don'?t|do not|skip it|skip)(?:[.!\s]*)$/i.test(String(text || '').trim());
}

function referencedTool(text, item) {
  const value = String(text || '').toLowerCase();
  if (!item) return false;
  return value.includes(item.tool) || value.includes(String(item.label || '').toLowerCase());
}

function approvalAttempt(text) {
  return /^(?:approve(?:d)?|yes|yep|yeah|ok(?:ay)?|allow\s+it|go\s+ahead|proceed|use\s+(?:it|apollo)|do\s+it)\b/i.test(String(text || '').trim());
}

function approvalModifiers(text) {
  const original = String(text || '').trim();
  if (!original || /https?:\/\/|docs\.google\.com|@\w/.test(original)) return null;
  const prefix = original.match(/^(?:approve(?:d)?|yes|yep|yeah|ok(?:ay)?|allow\s+it|go\s+ahead|proceed|use\s+(?:it|apollo)|do\s+it)(?:\s+apollo)?(?:\s+for\s+this\s+(?:one\s+)?run(?:\s+only)?)?[\s,:;.!-]*/i);
  if (!prefix) return null;
  let tail = original.slice(prefix[0].length).trim();
  tail = tail.replace(/^and\s+/i, '').replace(/^also\s+/i, '').trim();
  if (!tail) return {};

  const contactColumns = /^(?:make|add|create|ensure)\s+(?:the\s+)?(?:(?:phone|mobile)(?:\s+(?:and|&|\+)\s+(?:email|e\s*mail))?|(?:email|e\s*mail)(?:\s+(?:and|&|\+)\s+(?:phone|mobile))?)\s+columns?(?:\s+(?:too|as\s+well))?[.!\s]*$/i;
  if (contactColumns.test(tail)) return { ensureContactColumns: true };
  return null;
}

function affirmativeFor(text, item, allowGeneric = false) {
  const value = String(text || '').trim().toLowerCase();
  if (!value || /https?:\/\/|docs\.google\.com|@\w/.test(value)) return false;
  if (allowGeneric && approvalModifiers(value) !== null) return true;
  const tool = String(item?.tool || '').toLowerCase();
  const label = String(item?.label || '').toLowerCase();
  const mentions = tool && (value.includes(tool) || (label && value.includes(label)));
  if (!mentions) return false;
  if (approvalModifiers(value) !== null) return true;
  if (/\b(?:approve|approved|allow|yes|yep|yeah|okay|ok)\b/i.test(value)) return true;
  if (/\bgo\s+ahead\s+(?:with|and\s+use)\b/i.test(value)) return true;
  if (/^use\s+apollo(?:\s+(?:now|for\s+this\s+run|this\s+time))?[.!\s]*$/i.test(value)) return true;
  return false;
}

function resolveMessage(text) {
  const state = prune();
  if (!state.pending.length) return null;
  const value = String(text || '').trim();
  if (!value) return null;

  let candidates = state.pending.filter((item) => referencedTool(value, item));
  if (!candidates.length && state.pending.length === 1 && (affirmativeFor(value, state.pending[0], true) || negative(value))) candidates = [state.pending[0]];
  if (candidates.length !== 1) return null;
  const item = candidates[0];

  let decision = null;
  if (negative(value)) decision = 'denied';
  else if (affirmativeFor(value, item, state.pending.length === 1)) decision = 'approved';
  if (!decision) return null;

  const modifiers = decision === 'approved' ? (approvalModifiers(value) || {}) : {};
  state.pending = state.pending.filter((row) => row.id !== item.id);
  const resolved = { ...item, status: decision, modifiers, resolvedAt: new Date().toISOString() };
  state.history.push(resolved);
  save(state);
  return resolved;
}

function prompt(item) {
  const detail = item?.summary ? ` ${item.summary}` : '';
  return `Apollo requires approval before I use it, Sir. It is an office-owned API that can consume credits.${detail} Approve Apollo for this one run only? Nothing will be queried or charged until you approve.`;
}

function isPermitted(tool) {
  const key = definition(tool).key;
  if (key !== 'apollo') return true;
  const store = permitStore.getStore();
  return Boolean(store?.tools?.has('apollo'));
}

function assertPermitted(tool) {
  const key = definition(tool).key;
  if (key !== 'apollo') return true;
  if (isPermitted('apollo')) return true;
  const error = new Error('Apollo is blocked until the user explicitly approves this run.');
  error.code = 'PAID_TOOL_APPROVAL_REQUIRED';
  error.tool = 'apollo';
  throw error;
}

async function withPermit(approval, fn) {
  if (!approval || approval.status !== 'approved' || String(approval.tool || '').toLowerCase() !== 'apollo') {
    throw new Error('A resolved Apollo approval is required.');
  }
  const parent = permitStore.getStore();
  const tools = new Set(parent?.tools || []);
  tools.add('apollo');
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
    approvalScope: 'apollo-only',
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
  approvalAttempt,
  approvalModifiers,
  isPermitted,
  assertPermitted,
  withPermit,
  installApolloGuard,
  status,
};
