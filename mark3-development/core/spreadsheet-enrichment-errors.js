'use strict';

// One error vocabulary for universal spreadsheet enrichment.
// Machine codes remain available in metadata/logs, but user-facing text is plain English.

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
    error?.status,
    error?.endpoint,
  ].map(text).filter(Boolean).join(' ');
}

function subsystemFor(error, context = {}) {
  const explicit = text(error?.subsystem || context.subsystem).toUpperCase();
  if (explicit) return explicit;
  const value = `${combined(error)} ${text(context.endpoint)}`.toUpperCase();
  if (/APOLLO|API\.APOLLO\.IO/.test(value) || /apollo-enrichment/i.test(error?.stack || '')) return 'APOLLO';
  if (/GOOGLE_SHEETS|GOOGLE SHEETS|google-sheets|SHEETS\.GOOGLEAPIS\.COM/i.test(value)) return 'GOOGLE_SHEETS';
  if (/BIG_PICKLE|BIG PICKLE|big-pickle|omniroute/i.test(value)) return 'BIG_PICKLE';
  if (/LINKEDIN|linkedin-/i.test(value)) return 'LINKEDIN';
  if (/GEMINI/.test(value)) return 'GEMINI';
  if (/GROQ/.test(value)) return 'GROQ';
  if (/NVIDIA|NEMOTRON/.test(value)) return 'NVIDIA';
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
  const status = Number(error?.status || error?.providerStatus || 0);
  if (status === 429) return 'RATE_LIMIT';
  if (status === 401) return 'AUTH';
  if (status === 403) return 'PERMISSION';
  if (/AUTH|UNAUTHENTICATED|INVALID_GRANT|TOKEN|CREDENTIAL|API[_ -]?KEY/.test(`${code} ${value}`)) return 'AUTH';
  if (/FORBIDDEN|PERMISSION|ACCESS_REQUIRED|ACCESS DENIED/.test(`${code} ${value}`)) return 'PERMISSION';
  if (/RATE_LIMIT|RESOURCE_EXHAUSTED|429|QUOTA|DAILY_CAP|HOURLY_CAP|SAFETY_CAP/.test(`${code} ${value}`)) return 'RATE_LIMIT';
  if (/MAXIMUM CALL STACK SIZE EXCEEDED|STACK OVERFLOW|RANGEERROR/.test(`${code} ${value}`)) return 'RECURSION';
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
  if (type === 'RECURSION') return 'UNIVERSAL_RECURSION_STACK_OVERFLOW';
  return 'UNIVERSAL_INTERNAL_UNCLASSIFIED';
}

function subsystemLabel(subsystem) {
  return ({
    APOLLO: 'Apollo',
    GOOGLE_SHEETS: 'Google Sheets',
    LINKEDIN: 'LinkedIn',
    BIG_PICKLE: 'Big Pickle fallback',
    GEMINI: 'Gemini',
    GROQ: 'Groq',
    NVIDIA: 'NVIDIA',
    TARGETING: 'Worksheet targeting',
    SCHEMA: 'Spreadsheet schema',
    CONTROL_PLANE: 'ULTRON routing',
    NETWORK: 'Network',
    UNIVERSAL: 'ULTRON enrichment',
    DISCOVERY: 'Contact discovery',
  })[String(subsystem || '').toUpperCase()] || 'ULTRON';
}

function humanTitleFor(subsystem, type, code, message = '') {
  const s = String(subsystem || '').toUpperCase();
  const t = String(type || '').toUpperCase();
  const c = String(code || '').toUpperCase();
  const m = String(message || '').toUpperCase();

  if (/LINKEDIN_MCP_TOOL_ERROR/.test(c) || /ANOTHER LINKEDIN MCP CLIENT|BROWSER.*USING/.test(m)) return 'LinkedIn browser is already busy';
  if (/LINKEDIN_COOLDOWN_ACTIVE/.test(c) || /COOLDOWN/.test(c + ' ' + m)) return 'LinkedIn safety cooldown is active';
  if (/LINKEDIN_DAILY_CAP/.test(c)) return 'LinkedIn daily safety limit reached';
  if (/LINKEDIN_HOURLY_CAP/.test(c)) return 'LinkedIn hourly safety limit reached';
  if (/SERP_PUBLIC_LINKEDIN_SEARCH_FAILED/.test(c)) return 'Public LinkedIn search returned no usable results';

  if (/GOOGLE_SHEETS_AUTH_REQUIRED|UNAUTHENTICATED|INVALID_GRANT/.test(c + ' ' + m)) return 'Google Sheets authorization expired or is invalid';
  if (/UNIVERSAL_INSPECTION_TARGET_REQUIRED|UNIVERSAL_SHEET_TARGET_REQUIRED/.test(c)) return 'Worksheet target is missing';
  if (/UNIVERSAL_SHEET_TAB_NOT_FOUND|TAB_NOT_FOUND/.test(c)) return 'The requested worksheet tab could not be found';
  if (/UNIVERSAL_SCHEMA_CONFIDENCE_TOO_LOW/.test(c)) return 'Spreadsheet columns could not be identified safely';

  if (/APOLLO_NETWORK_BODY_READ_FAILED/.test(c)) return 'Apollo connection was interrupted while reading the response';
  if (/APOLLO_NETWORK_FETCH_FAILED/.test(c)) return 'Apollo could not be reached after automatic retries';

  if (/POC2_NO_VERIFIED_CANDIDATE_AFTER_ALL_STRATEGIES/.test(c)) return 'No verified same-company POC-2 could be found';
  if (/POC2_NO_DISCOVERY_CANDIDATES/.test(c)) return 'No safe POC-2 candidates were found';
  if (/POC2_CANDIDATES_FAILED_VERIFICATION/.test(c)) return 'POC-2 candidates were found but none passed verification';
  if (/EMPLOYER_NOT_VERIFIED|EMPLOYER_UNRESOLVED/.test(c)) return 'The hiring company could not be verified';
  if (/POC3_REQUESTED_UNRESOLVED/.test(c)) return 'Requested POC-3 could not be verified';
  if (/AI_NO_VERIFIED_CANDIDATE_POOL|AI_SKIPPED_NO_VERIFIED_CANDIDATE_POOL/.test(c)) return 'AI had no verified candidates to choose from';
  if (/AI_TARGET_NOT_OFFERED_TO_SELECTION/.test(c)) return 'AI selection was skipped because no safe candidate package existed';
  if (/AI_SELECTION_ABSTAINED/.test(c)) return 'AI could not safely choose a candidate';

  const label = subsystemLabel(s);
  if (t === 'RATE_LIMIT') return `${label} rate limit reached`;
  if (t === 'AUTH') return `${label} authentication or API-key problem`;
  if (t === 'PERMISSION') return `${label} access permission denied`;
  if (t === 'NETWORK') return `${label} could not be reached`;
  if (t === 'TIMEOUT') return `${label} request timed out`;
  if (t === 'CONFIG') return `${label} is not configured correctly`;
  if (t === 'INVALID_RANGE') return 'Google Sheets range is invalid';
  if (t === 'TARGETING') return 'Worksheet name or tab could not be resolved';
  if (t === 'SCHEMA') return 'Spreadsheet columns could not be understood safely';
  if (t === 'NOT_FOUND') return `${label} could not find the requested record`;
  if (t === 'AMBIGUITY') return `${label} found conflicting or ambiguous evidence`;
  if (t === 'BAD_REQUEST') return `${label} rejected the request as invalid`;
  if (t === 'RECURSION') return 'ULTRON hit an internal recursive loop';
  if (t === 'API') return `${label} returned an API error`;
  return `${label} encountered an internal error`;
}

function humanExplanationFor(subsystem, type, code, message = '') {
  const s = String(subsystem || '').toUpperCase();
  const t = String(type || '').toUpperCase();
  const c = String(code || '').toUpperCase();

  if (/LINKEDIN_MCP_TOOL_ERROR/.test(c)) return 'Another LinkedIn browser session is using the authenticated browser, so this stage was safely paused.';
  if (/LINKEDIN_COOLDOWN_ACTIVE/.test(c)) return 'ULTRON is respecting the LinkedIn safety delay and will not bypass it.';
  if (/SERP_PUBLIC_LINKEDIN_SEARCH_FAILED/.test(c)) return 'The public search provider returned no useful LinkedIn profile results for this attempt.';
  if (/APOLLO_NETWORK_FETCH_FAILED/.test(c)) return 'ULTRON retried the Apollo request automatically, but the connection still failed.';
  if (/APOLLO_NETWORK_BODY_READ_FAILED/.test(c)) return 'Apollo accepted the connection, but the response stream was interrupted before ULTRON could read it completely.';
  if (/GOOGLE_SHEETS_AUTH_REQUIRED/.test(c)) return 'The current Google authorization can no longer read or write the spreadsheet.';
  if (/UNIVERSAL_SHEET_TARGET_REQUIRED|UNIVERSAL_INSPECTION_TARGET_REQUIRED/.test(c)) return 'ULTRON does not have a safe exact worksheet name or tab identifier to inspect.';
  if (/POC2_NO_VERIFIED_CANDIDATE_AFTER_ALL_STRATEGIES/.test(c)) return 'All configured discovery and verification strategies were tried, but no distinct same-company person passed the safety checks.';

  if (t === 'RATE_LIMIT') return `${subsystemLabel(s)} temporarily rejected more requests because its usage limit was reached.`;
  if (t === 'AUTH') return `${subsystemLabel(s)} rejected the credentials or authorization currently configured.`;
  if (t === 'PERMISSION') return `${subsystemLabel(s)} is reachable, but the connected account is not allowed to perform this operation.`;
  if (t === 'NETWORK') return `${subsystemLabel(s)} could not be reached reliably after automatic retry.`;
  if (t === 'TIMEOUT') return `${subsystemLabel(s)} did not respond before the safe timeout expired.`;
  if (t === 'CONFIG') return `A required ${subsystemLabel(s)} setting, endpoint, key, or integration is missing or invalid.`;
  if (t === 'INVALID_RANGE') return 'The worksheet range being requested does not exist or is outside the physical sheet grid.';
  if (t === 'TARGETING') return 'ULTRON could not safely determine the exact worksheet that should be inspected or changed.';
  if (t === 'SCHEMA') return 'ULTRON could not map the worksheet columns with enough confidence to write safely.';
  if (t === 'NOT_FOUND') return `${subsystemLabel(s)} returned no matching record for the exact requested identity or resource.`;
  if (t === 'AMBIGUITY') return 'More than one plausible result existed, so ULTRON refused to guess.';
  if (t === 'BAD_REQUEST') return `${subsystemLabel(s)} rejected the request before processing it.`;
  if (t === 'RECURSION') return 'An internal wrapper or helper called itself repeatedly until JavaScript stopped the operation.';
  if (t === 'API') return `${subsystemLabel(s)} returned a provider-side error while processing the request.`;

  const clean = text(message).replace(/[A-Z][A-Z0-9_]{3,}/g, '').replace(/\s+/g, ' ').trim();
  return clean && clean.toLowerCase() !== 'unknown failure'
    ? clean
    : 'ULTRON stopped this stage safely because it could not confirm a reliable result.';
}

function hintFor(subsystem, type, code) {
  const c = String(code || '').toUpperCase();
  if (c === 'LINKEDIN_DAILY_CAP') return 'Wait for the LinkedIn daily safety window to reset. Do not bypass the account-safety limit.';
  if (c === 'LINKEDIN_HOURLY_CAP') return 'Wait for the LinkedIn hourly safety window to reset. Do not bypass the account-safety limit.';
  if (c === 'LINKEDIN_MCP_TOOL_ERROR') return 'Let the current LinkedIn browser operation finish, then retry only the affected LinkedIn stage.';
  if (c === 'LINKEDIN_COOLDOWN_ACTIVE') return 'Wait for the displayed LinkedIn cooldown to finish, then retry the affected stage.';
  if (type === 'RECURSION') return 'Restart ULTRON after checking recent wrappers or patches that may call each other recursively.';
  if (type === 'NETWORK') return `Check internet, DNS, firewall/proxy, and ${subsystemLabel(subsystem)} availability. ULTRON already retried automatically.`;
  if (type === 'AUTH') return `Refresh or re-authorize ${subsystemLabel(subsystem)}, then rerun the same operation.`;
  if (type === 'PERMISSION') return `Give the connected ${subsystemLabel(subsystem)} account permission for this resource or operation.`;
  if (type === 'RATE_LIMIT') return `Wait for the ${subsystemLabel(subsystem)} rate-limit window to reset, then resume the same run.`;
  if (subsystem === 'TARGETING') return 'Use the exact spreadsheet URL plus worksheet name or gid.';
  if (subsystem === 'SCHEMA') return 'Check the worksheet headers and contact columns. ULTRON deliberately refused an unsafe guess.';
  if (subsystem === 'BIG_PICKLE') return 'Keep deterministic enrichment authoritative; retry the fallback only if unresolved rows still need it.';
  if (type === 'INVALID_RANGE') return 'Check the exact worksheet name and A1 range.';
  if (type === 'CONFIG') return `Fix the missing or invalid ${subsystemLabel(subsystem)} configuration, then restart ULTRON.`;
  return 'Retry only the affected stage after checking the plain-English problem description above.';
}

function normalize(error, context = {}) {
  const original = error instanceof Error ? error : new Error(text(error) || 'unknown failure');
  const subsystem = subsystemFor(original, context);
  const type = typeFor(original, subsystem);
  const code = defaultCode(original, subsystem, type);
  const stage = text(original.stage || context.stage || 'unspecified-stage');
  const message = text(original.message || context.message || 'unknown failure');
  const humanTitle = humanTitleFor(subsystem, type, code, message);
  const humanExplanation = humanExplanationFor(subsystem, type, code, message);
  return {
    code,
    subsystem,
    type,
    stage,
    message,
    humanTitle,
    humanExplanation,
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
  const typed = value?.subsystem && value?.type ? {
    ...value,
    humanTitle: value.humanTitle || humanTitleFor(value.subsystem, value.type, value.code, value.message),
    humanExplanation: value.humanExplanation || humanExplanationFor(value.subsystem, value.type, value.code, value.message),
    hint: value.hint || hintFor(value.subsystem, value.type, value.code),
  } : normalize(value);
  const action = text(typed.hint) ? ` What to do: ${text(typed.hint)}` : '';
  return `Problem: ${typed.humanTitle}. ${typed.humanExplanation}${action}`;
}

module.exports = {
  NETWORK_PATTERN,
  subsystemFor,
  typeFor,
  defaultCode,
  normalize,
  format,
  hintFor,
  subsystemLabel,
  humanTitleFor,
  humanExplanationFor,
};
