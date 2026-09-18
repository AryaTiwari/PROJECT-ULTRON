'use strict';

// One error vocabulary for universal spreadsheet enrichment. Every failure that
// crosses the spreadsheet boundary should expose subsystem + type + code + stage
// instead of leaking raw provider/runtime strings such as "Failed to fetch".

const NETWORK_PATTERN = /failed to fetch|fetch failed|econnrefused|econnreset|enotfound|eai_again|etimedout|socket|tls|network|dns/i;

function text(value) { return String(value == null ? '' : value).trim(); }

function combined(error) {
  return [
    error?.code,
    error?.message,
    error?.name,
    error?.stack,
    error?.cause?.code,
    error?.cause?.message,
  ].map(text).filter(Boolean).join(' ');
}

function subsystemFor(error, context = {}) {
  const explicit = text(error?.subsystem || context.subsystem).toUpperCase();
  if (explicit) return explicit;
  const value = combined(error).toUpperCase();
  if (/APOLLO/.test(value) || /apollo-enrichment/i.test(error?.stack || '')) return 'APOLLO';
  if (/GOOGLE_SHEETS|GOOGLE SHEETS|google-sheets/i.test(value)) return 'GOOGLE_SHEETS';
  if (/BIG_PICKLE|BIG PICKLE|big-pickle|omniroute/i.test(value)) return 'BIG_PICKLE';
  if (/LINKEDIN|linkedin-/i.test(value)) return 'LINKEDIN';
  if (/SCHEMA|HEADER|COLUMN_RELATION|COLUMN MAPPING/.test(value)) return 'SCHEMA';
  if (/TAB_|TARGET_|GID_|WORKSHEET|SHEET_TAB|TAB NOT FOUND/.test(value)) return 'TARGETING';
  if (/APPROVAL|CONTROL_PLANE|ROUTE_INVARIANT/.test(value)) return 'CONTROL_PLANE';
  if (NETWORK_PATTERN.test(combined(error))) return 'NETWORK';
  return 'UNIVERSAL';
}

function typeFor(error, subsystem) {
  const explicit = text(error?.errorType || error?.type).toUpperCase();
  if (explicit) return explicit;
  const code = text(error?.code).toUpperCase();
  const value = combined(error).toUpperCase();
  if (/AUTH|UNAUTHENTICATED|INVALID_GRANT|TOKEN|CREDENTIAL/.test(`${code} ${value}`)) return 'AUTH';
  if (/FORBIDDEN|PERMISSION|ACCESS_REQUIRED|ACCESS DENIED/.test(`${code} ${value}`)) return 'PERMISSION';
  if (/RATE_LIMIT|RESOURCE_EXHAUSTED|429|QUOTA/.test(`${code} ${value}`)) return 'RATE_LIMIT';
  if (/TIMEOUT|TIMEDOUT|DEADLINE_EXCEEDED/.test(`${code} ${value}`)) return 'TIMEOUT';
  if (NETWORK_PATTERN.test(combined(error))) return 'NETWORK';
  if (/RANGE_INVALID|INVALID_RANGE|PARSE RANGE/.test(`${code} ${value}`)) return 'INVALID_RANGE';
  if (/BAD_REQUEST|INVALID_ARGUMENT/.test(`${code} ${value}`)) return 'BAD_REQUEST';
  if (/NOT_FOUND|NOT FOUND|MISSING/.test(`${code} ${value}`)) return 'NOT_FOUND';
  if (subsystem === 'TARGETING' || /TAB_|TARGET_|GID_|WORKSHEET/.test(code)) return 'TARGETING';
  if (subsystem === 'SCHEMA' || /SCHEMA|COLUMN|HEADER/.test(code)) return 'SCHEMA';
  if (/CONFIG|NOT_CONFIGURED|REQUIRED/.test(code)) return 'CONFIG';
  if (/AMBIG|LOW_CONFIDENCE|TIE/.test(`${code} ${value}`)) return 'AMBIGUITY';
  if (/API|HTTP_|UNAVAILABLE|FAILED/.test(code)) return 'API';
  return 'INTERNAL';
}

function defaultCode(error, subsystem, type) {
  const existing = text(error?.code);
  if (existing) return existing;
  if (subsystem === 'APOLLO' && type === 'NETWORK') return 'APOLLO_NETWORK_FETCH_FAILED';
  if (subsystem === 'GOOGLE_SHEETS' && type === 'NETWORK') return 'GOOGLE_SHEETS_NETWORK_ERROR';
  if (subsystem === 'LINKEDIN' && type === 'NETWORK') return 'LINKEDIN_NETWORK_ERROR';
  if (subsystem === 'BIG_PICKLE' && type === 'NETWORK') return 'BIG_PICKLE_NETWORK_ERROR';
  if (type === 'NETWORK') return 'SPREADSHEET_NETWORK_ERROR';
  return 'UNIVERSAL_INTERNAL_UNCLASSIFIED';
}

function hintFor(subsystem, type, code) {
  if (type === 'NETWORK') return `${subsystem} could not be reached after automatic retry. Check internet, DNS, firewall/proxy and provider availability.`;
  if (type === 'AUTH') return `Refresh or re-authorize ${subsystem} credentials, then rerun the same operation.`;
  if (type === 'PERMISSION') return `The connected ${subsystem} identity lacks permission for this operation or resource.`;
  if (type === 'RATE_LIMIT') return `${subsystem} rejected the request for quota/rate-limit reasons. Reduce burst size or retry after the provider window resets.`;
  if (subsystem === 'TARGETING') return 'Check the exact spreadsheet URL, worksheet name and gid. Explicit worksheet names remain authoritative.';
  if (subsystem === 'SCHEMA') return 'Inspect the worksheet header and inferred contact groups; ULTRON refused to guess an unsafe mapping.';
  if (subsystem === 'BIG_PICKLE') return 'Deterministic enrichment remains authoritative. Big Pickle fallback may abstain without blocking already-resolved deterministic work.';
  if (type === 'INVALID_RANGE') return 'Check the exact A1 range and worksheet name used by the Google Values API.';
  if (type === 'CONFIG') return `Required configuration for ${subsystem} is missing or invalid.`;
  return `Inspect the typed code ${code} and stage for the failing subsystem.`;
}

function normalize(error, context = {}) {
  const original = error instanceof Error ? error : new Error(text(error) || 'unknown failure');
  const subsystem = subsystemFor(original, context);
  const type = typeFor(original, subsystem);
  const code = defaultCode(original, subsystem, type);
  const stage = text(original.stage || context.stage || 'unspecified-stage');
  const message = text(original.message || context.message || 'unknown failure');
  return {
    code,
    subsystem,
    type,
    stage,
    message,
    hint: text(original.hint) || hintFor(subsystem, type, code),
    status: original.status ?? null,
    retryAttempts: original.retryAttempts ?? null,
    attemptedRange: text(original.requestedRange || original.originalRange || context.attemptedRange) || null,
    endpoint: text(original.endpoint || context.endpoint) || null,
    providerStatus: original.status ?? null,
    causeCode: text(original?.cause?.code) || null,
    original,
  };
}

function format(value) {
  const typed = value?.subsystem && value?.type ? value : normalize(value);
  return `[${typed.subsystem}/${typed.type}] ${typed.code} @ ${typed.stage}: ${typed.message}`;
}

module.exports = {
  NETWORK_PATTERN,
  subsystemFor,
  typeFor,
  normalize,
  format,
  hintFor,
};
