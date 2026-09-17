// Scoped resilience for the exact LinkedIn POC-1 profile reads used only by
// anchored 3-POC enrichment. The existing employer fallback remains the owner of
// employer extraction; this layer only makes its get_person_profile transport
// more reliable and exposes why a profile could not be read.

const threePoc = require('./three-poc-enrichment-operator');
const linkedinMcp = require('./linkedin-mcp-client');
const joeyism = require('./linkedin-joeyism-bridge');

const INSTALL_FLAG = Symbol.for('ultron.mark3.threePocLinkedinProfileResilience.installed');
let runState = freshState();

function freshState() {
  return {
    primaryCalls: 0,
    primarySuccesses: 0,
    emptyPayloads: 0,
    lightRetries: 0,
    lightRetrySuccesses: 0,
    joeyismAttempts: 0,
    joeyismSuccesses: 0,
    errors: 0,
    errorCodes: {},
    lastErrors: [],
  };
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function flatten(value, out = [], depth = 0) {
  if (depth > 6 || value == null || out.join(' ').length > 6000) return out;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const text = clean(value);
    if (text) out.push(text);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 60)) flatten(item, out, depth + 1);
    return out;
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      if (/image|avatar|photo|tracking|cookie|token/i.test(key)) continue;
      flatten(item, out, depth + 1);
    }
  }
  return out;
}

function usableProfile(value) {
  return flatten(value).join(' ').trim().length >= 20;
}

function profileUrl(args = {}) {
  const slug = clean(args.linkedin_username || args.username || '').replace(/^\/+|\/+$/g, '');
  return slug ? `https://www.linkedin.com/in/${slug}/` : '';
}

function recordError(error, stage) {
  runState.errors++;
  const code = clean(error?.code || error?.linkedinSafety?.kind || 'UNKNOWN');
  runState.errorCodes[code] = Number(runState.errorCodes[code] || 0) + 1;
  runState.lastErrors.push({
    stage,
    code,
    message: clean(error?.message || error).slice(0, 280),
  });
  runState.lastErrors = runState.lastErrors.slice(-6);
}

function fallbackEligible(error) {
  const text = `${error?.code || ''} ${error?.message || ''}`;
  return /LINKEDIN_MCP_|auth|session|browser|profile|timeout|transport|connection/i.test(text);
}

async function maybeJoeyism(args, reason = null) {
  if (!joeyism.enabled()) return null;
  const url = profileUrl(args);
  if (!url) return null;
  runState.joeyismAttempts++;
  try {
    const result = await joeyism.call('person', { url });
    if (usableProfile(result)) {
      runState.joeyismSuccesses++;
      return result;
    }
    runState.emptyPayloads++;
    return null;
  } catch (error) {
    recordError(error, reason ? `joeyism-after-${reason}` : 'joeyism');
    return null;
  }
}

async function resilientPersonCall(originalCall, args = {}) {
  runState.primaryCalls++;
  let primaryError = null;
  try {
    const result = await originalCall('get_person_profile', args);
    if (usableProfile(result)) {
      runState.primarySuccesses++;
      return result;
    }
    runState.emptyPayloads++;
  } catch (error) {
    primaryError = error;
    recordError(error, 'primary');
  }

  // Some LinkedIn MCP/profile states return an empty detailed-section payload.
  // Retry once with a lighter top-card request instead of repeating the same
  // deep scrape. This remains an authenticated, read-only profile request.
  runState.lightRetries++;
  try {
    const lightArgs = {
      linkedin_username: args.linkedin_username,
      max_scrolls: 1,
    };
    const result = await originalCall('get_person_profile', lightArgs);
    if (usableProfile(result)) {
      runState.lightRetrySuccesses++;
      return result;
    }
    runState.emptyPayloads++;
  } catch (error) {
    recordError(error, 'light-retry');
    if (!primaryError) primaryError = error;
  }

  // Reuse Mark 3's existing manual-session exact-profile fallback when it is
  // configured. Never broaden to search_people here: this is exact POC-1 identity.
  if (!primaryError || fallbackEligible(primaryError)) {
    const fallback = await maybeJoeyism(args, primaryError ? 'error' : 'empty');
    if (fallback) return fallback;
  }

  if (primaryError) throw primaryError;
  return {};
}

function startRun() {
  runState = freshState();
  return stats();
}

function stats() {
  return {
    ...runState,
    joeyismEnabled: joeyism.enabled(),
    joeyismSessionReady: Boolean(joeyism.status().sessionReady),
  };
}

function install() {
  if (globalThis[INSTALL_FLAG]) return globalThis[INSTALL_FLAG];

  const originalEnrichWorkbook = threePoc.enrichWorkbook.bind(threePoc);
  const originalFormatResult = threePoc.formatResult.bind(threePoc);

  threePoc.enrichWorkbook = async function resilientThreePocLinkedinProfiles(...args) {
    startRun();
    const previousCallTool = linkedinMcp.callTool;
    const boundCallTool = previousCallTool.bind(linkedinMcp);
    linkedinMcp.callTool = async (tool, toolArgs = {}) => {
      if (tool !== 'get_person_profile') return boundCallTool(tool, toolArgs);
      return resilientPersonCall(boundCallTool, toolArgs);
    };
    try {
      const result = await originalEnrichWorkbook(...args);
      return { ...result, linkedinProfileResilience: stats() };
    } finally {
      linkedinMcp.callTool = previousCallTool;
    }
  };

  threePoc.formatResult = function resilientProfileFormatResult(result) {
    const base = originalFormatResult(result);
    const s = result?.linkedinProfileResilience;
    if (!s) return base;
    const codes = Object.entries(s.errorCodes || {}).map(([code, count]) => `${code}:${count}`).join(', ') || 'none';
    return `${base} Exact-profile read resilience: ${s.primarySuccesses}/${s.primaryCalls} primary reads succeeded; ${s.emptyPayloads} empty payloads; ${s.lightRetrySuccesses}/${s.lightRetries} light retries succeeded; ${s.joeyismSuccesses}/${s.joeyismAttempts} Joeyism rescues; ${s.errors} errors [${codes}]. Joeyism ready: ${s.joeyismEnabled && s.joeyismSessionReady ? 'yes' : 'no'}.`;
  };

  const api = Object.freeze({ startRun, stats, usableProfile, profileUrl });
  globalThis[INSTALL_FLAG] = api;
  return api;
}

module.exports = {
  install,
  startRun,
  stats,
  usableProfile,
  profileUrl,
};
