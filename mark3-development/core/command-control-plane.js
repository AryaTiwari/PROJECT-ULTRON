'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const scope = new AsyncLocalStorage();
const linkedinIntent = require('./linkedin-lead-intent');
const apolloLeadIntent = require('./apollo-lead-intent-compiler');

// Ownership precedes interpretation. No model/bootstrap import belongs here.
// HTTP dispatch owns exclusive domain routing and paid-tool approval re-entry.
function normalize(message) {
  return String(message || '').trim().replace(/^(?:hey\s+)?ultron\b[\s,:;.!-]*/i, '').replace(/\blinked\s+in\b/ig, 'LinkedIn');
}

function spreadsheetSourceSignals(text, options = {}) {
  const attachments = Array.isArray(options.attachments) ? options.attachments : [];
  const hasSpreadsheetAttachment = attachments.some((item) => {
    const name = String(item?.name || item?.filename || '').trim();
    const mime = String(item?.mime || item?.mimeType || '').trim();
    return /\.(?:xlsx?|csv)$/i.test(name) || /spreadsheetml|ms-excel|text\/csv/i.test(mime);
  });
  const hasMentionedWorkbook = /@[\w .()\-]{2,}/.test(text)
    && /\b(?:sheet|spreadsheet|workbook|excel|csv|tab)\b/i.test(text);
  const hasGoogleSheet = /https:\/\/docs\.google\.com\/spreadsheets\/d\/[a-zA-Z0-9_-]+/i.test(text);
  return { hasSpreadsheetAttachment, hasMentionedWorkbook, hasGoogleSheet, hasSource: hasSpreadsheetAttachment || hasMentionedWorkbook || hasGoogleSheet };
}

function isThreePocSpreadsheetRequest(message, options = {}) {
  const text = normalize(message);

  if (!text) return false;
  const source = spreadsheetSourceSignals(text, options);
  if (!source.hasSource) return false;

  const slotPatterns = [
    /\b(?:1st|first)\s+poc\b|\bpoc\s*[- ]?1\b/i,
    /\b(?:2nd|second)\s+poc\b|\bpoc\s*[- ]?2\b/i,
    /\b(?:3rd|third)\s+poc\b|\bpoc\s*[- ]?3\b/i,
  ];
  const slotCount = slotPatterns.filter((pattern) => pattern.test(text)).length;
  const explicitThreePoc = /\b(?:3\s*[- ]?pocs?|three\s+pocs?)\b/i.test(text);
  const anchoredContract = /\banchored(?:\s+legacy)?\b/i.test(text)
    || (/\bperson\s+or\s+company\s+name\b/i.test(text) && /\blinkedin\s+id\b/i.test(text) && slotCount >= 2);
  const action = /\b(?:perform|run|process|enrich|enrichment|fill|populate|complete|update|add|get|do|repair)\b/i.test(text);
  return action && (explicitThreePoc || slotCount >= 2 || anchoredContract);
}

function isUniversalSpreadsheetEnrichmentRequest(message, options = {}) {
  const text = normalize(message);

  if (!text) return false;
  if (linkedinIntent.isLeadDiscoveryRequest(text)) return false;
  const source = spreadsheetSourceSignals(text, options);
  if (!source.hasSource) return false;

  const action = /\b(?:enrich|research|find|discover|fill|populate|complete|repair|verify|resolve|source|append|add|update)\b/i.test(text);
  const enrichmentObject = /\b(?:contacts?|people|persons?|decision\s*makers?|pocs?|leads?|recruiters?|hiring|employees?|founders?|owners?|managers?|directors?|linkedin|emails?|e-?mails?|phones?|mobiles?|designations?|titles?|employers?|companies?|missing\s+(?:data|fields?|columns?|contacts?))\b/i.test(text);
  const explicitEnrichment = /\b(?:contact|lead|person|people|company|business|linkedin|apollo|decision\s*maker|poc)\s+(?:enrichment|research)\b/i.test(text)
    || /\benrich(?:ment)?\b/i.test(text);
  return action && (enrichmentObject || explicitEnrichment);
}

function isLocalThreePocWorkbookRequest(message, options = {}) {
  return isThreePocSpreadsheetRequest(message, options);
}

function claim(message, options = {}) {
  const text = normalize(message);
  if (require('./universal-enrichment-control-plane').isControlRequest(text)) {
    return Object.freeze({
      domain: 'spreadsheet-enrichment', claimed: true, exclusive: true,
      controller: 'universal-spreadsheet-domain-controller', generalModelAllowed: false,
      artifactAllowed: false, allowWebFallback: false, yieldTo: null,
      controlCommand: true, readOnlyStatus: /(?:status|progress|health)/i.test(text),
    });
  }
  if (apolloLeadIntent.isApolloLeadControlRequest?.(text)) {
    return Object.freeze({
      domain: 'apollo-lead', claimed: true, exclusive: true,
      controller: 'apollo-lead-domain-controller', generalModelAllowed: false,
      artifactAllowed: false, allowWebFallback: false, yieldTo: null,
      controlCommand: true, readOnlyStatus: true,
    });
  }
  if (linkedinIntent.isLeadDiscoveryRequest(text)) {
    return Object.freeze({
      domain: 'linkedin', claimed: true, exclusive: true,
      controller: 'linkedin-domain-controller', generalModelAllowed: false,
      artifactAllowed: false, allowWebFallback: false, yieldTo: null,
    });
  }
  if (isThreePocSpreadsheetRequest(text, options)) {
    return Object.freeze({
      domain: 'three-poc-spreadsheet', claimed: true, exclusive: true,
      controller: 'three-poc-domain-controller', generalModelAllowed: false,
      artifactAllowed: false, allowWebFallback: false, yieldTo: null,
    });
  }
  if (apolloLeadIntent.isApolloLeadRequest(text)) {
    return Object.freeze({
      domain: 'apollo-lead', claimed: true, exclusive: true,
      controller: 'apollo-lead-domain-controller', generalModelAllowed: false,
      artifactAllowed: false, allowWebFallback: false, yieldTo: null,
    });
  }
  if (isUniversalSpreadsheetEnrichmentRequest(text, options)) {
    return Object.freeze({
      domain: 'spreadsheet-enrichment', claimed: true, exclusive: true,
      controller: 'universal-spreadsheet-domain-controller', generalModelAllowed: false,
      artifactAllowed: false, allowWebFallback: false, yieldTo: null,
    });
  }

  const linkedin = /\blinkedin\b|linkedin\.com\/|\b(?:search_jobs|get_job_details|get_company_profile|search_companies|search_people|get_person_profile)\b/i.test(text);
  const apolloEnrichment = linkedinIntent.contactEnrichmentRequested(text) && /\bapollo\b/i.test(text)
    && /\b(?:enrich|enrichment|email|e-?mail|phone|mobile|numbers?|contacts?|leads?|compan(?:y|ies)|sheet|master)\b/i.test(text);
  const emailOutreach = !apolloEnrichment
    && /\b(?:email outreach|email campaign|personalized emails?|send emails?|follow[- ]?up emails?)\b/i.test(text)
    && !/^\s*(?:find|search|research|discover|source|get)\b[\s\S]{0,100}\blinkedin\b/i.test(text);
  const operationalDomain = apolloEnrichment || (linkedin && !emailOutreach);
  const operationFirst = /^(?:(?:please|can you|could you)\s+)?(?:resume|continue|find|search|reuse|verify|deduplicate|dedupe|fill|update|pause|cancel|stop)\b/i.test(text);
  const artifact = linkedin && !operationFirst && text.split(/[.!?;\n]/).some(clause =>
    !/\b(?:no|not|never|don't|without)\b/i.test(clause) &&
    /\b(?:create|generate|export|render|produce|convert|prepare|make)\b[^\n]*\b(?:pdf|docx|word document|image|video|spreadsheet export)\b/i.test(clause));
  const operational = operationalDomain && /\b(?:resume|continue|find|get|look|pull|search|reuse|verify|deduplicate|dedupe|fill|build|update|collect|scrape|extract|add|append|enrich|retry|sync|complete|finish|pause|cancel|stop|progress|status|health|setup|login|unlock|mission|mcp|email|phone|mobile|numbers?|contacts?|search_jobs|get_job_details|get_company_profile|search_companies|search_people|get_person_profile)\b/i.test(text);
  const exclusive = operational && !artifact;
  return Object.freeze({ domain: exclusive ? 'linkedin' : artifact ? 'artifact' : 'general', claimed: exclusive || artifact, exclusive,
    controller: exclusive ? 'linkedin-domain-controller' : null,
    generalModelAllowed: !exclusive, artifactAllowed: !exclusive, allowWebFallback: !exclusive });
}

function isInternalModelPayload(value) {
  const text = String(value || '').trim();
  if (!text || !/^[\[{]/.test(text)) return false;
  try { JSON.parse(text); return true; } catch { return false; }
}

function invariantCodeForDomain(domain) {
  if (domain === 'linkedin') return 'LINKEDIN_ROUTE_INVARIANT_VIOLATION';
  if (domain === 'three-poc-spreadsheet') return 'THREE_POC_ROUTE_INVARIANT_VIOLATION';
  if (domain === 'spreadsheet-enrichment') return 'SPREADSHEET_ENRICHMENT_ROUTE_INVARIANT_VIOLATION';
  if (domain === 'apollo-lead') return 'APOLLO_LEAD_ROUTE_INVARIANT_VIOLATION';
  return 'DOMAIN_ROUTE_INVARIANT_VIOLATION';
}

function assertAllowed(kind, { model = '', messages = [] } = {}) {
  const current = scope.getStore();
  if (kind === 'general-model' && current?.internalInferenceDomain && current?.route?.domain === current.internalInferenceDomain) return;
  if (kind === 'direct-model'
      && ['spreadsheet-enrichment', 'linkedin', 'apollo-lead'].includes(current?.internalInferenceDomain)
      && current?.route?.domain === current.internalInferenceDomain) return;
  const lastUser = (Array.isArray(messages) ? messages : []).filter(item => item.role === 'user').at(-1)?.content;
  const inferred = !current && !isInternalModelPayload(lastUser) ? claim(typeof lastUser === 'string' ? lastUser : '') : null;
  if (!current?.route.exclusive && !inferred?.exclusive) return;
  if (kind === 'direct-model' && current?.compiler && /^gemini\//i.test(model)) return;
  const domain = current?.route?.domain || inferred?.domain || 'exclusive';
  const error = Object.assign(new Error(`${domain} exclusive route forbids ${kind}`), { code: invariantCodeForDomain(domain) });
  if (current) current.violation = error;
  console.error(error.code, JSON.stringify({ domain, attempted: kind }));
  throw error;
}

function runInternalInference(domain, fn) {
  if (typeof fn !== 'function') throw new TypeError('runInternalInference requires a function.');
  const requestedDomain = String(domain || '').trim();
  if (!requestedDomain) throw new Error('runInternalInference requires a domain.');
  const current = scope.getStore();
  const route = current?.route?.domain === requestedDomain ? current.route : Object.freeze({
    domain: requestedDomain, claimed: true, exclusive: true, controller: null,
    generalModelAllowed: false, artifactAllowed: false, allowWebFallback: false,
  });
  return scope.run({ ...(current || {}), route, compiler: false, internalInferenceDomain: requestedDomain, violation: null }, fn);
}

function runExclusive(fn) {
  return scope.run({ route: claim('LinkedIn mission'), compiler: false }, async () => {
    const result = await fn();
    if (scope.getStore().violation) throw scope.getStore().violation;
    return result;
  });
}
function compileWithGemini(fn) {
  const current = scope.getStore();
  return scope.run({ ...(current || { route: claim('LinkedIn mission') }), compiler: true }, fn);
}

async function resolveUniversalPaidApproval(message) {
  const paidTools = require('./paid-tool-approval');
  const handler = require('./universal-paid-approval-handler');
  const pending = paidTools.pending('apollo');
  if (!pending) return null;

  const decision = paidTools.resolveMessage(String(message || ''));
  if (!decision) return null;

  let result;
  try {
    if (decision.operation === handler.OPERATION) result = await handler.execute(decision);
    else if (decision.operation === require('./apollo-lead-domain-controller').OPERATION) {
      result = await require('./apollo-lead-approval-handler').execute(decision);
    } else result = null;
  } catch (error) {
    const typedErrors = require('./spreadsheet-enrichment-errors');
    const typed = typedErrors.normalize(error, {
      stage: error?.stage || 'approval-reentry-dispatch',
    });
    const diagnostic = typedErrors.format(typed);
    result = {
      ok: false,
      text: `Universal spreadsheet approval re-entry stopped safely: ${diagnostic}. ${typed.hint}`,
      response: `Universal spreadsheet approval re-entry stopped safely: ${diagnostic}. ${typed.hint}`,
      error: typed.code,
      errorCode: typed.code,
      errorSubsystem: typed.subsystem,
      errorType: typed.type,
      errorStage: typed.stage,
      errorHint: typed.hint,
      errorMessage: typed.message,
      retryAttempts: typed.retryAttempts,
      endpoint: typed.endpoint || null,
      executionContract: 'universal-coordinated-multi-poc-v4',
      model: 'mark3-universal-deterministic-enrichment',
      provider: 'local-spreadsheet-control',
      taskType: 'universal-sheet-enrichment',
    };
  }
  if (!result) return null;

  const apolloLead = decision.operation === require('./apollo-lead-domain-controller').OPERATION;
  const route = Object.freeze({
    domain: apolloLead ? 'apollo-lead' : 'spreadsheet-enrichment', claimed: true, exclusive: true,
    controller: apolloLead ? 'apollo-lead-domain-controller' : 'universal-spreadsheet-domain-controller', generalModelAllowed: false,
    artifactAllowed: false, allowWebFallback: false, yieldTo: null,
    approvalReentry: true,
  });
  require('./events').emit('command_route_decision', route);
  require('./events').emit('universal_spreadsheet_approval_resolved', {
    approvalId: decision.id,
    status: decision.status,
    operation: decision.operation,
  });
  return { ...result, route: route.domain, routing: route };
}

async function dispatch(message, options = {}) {
  const originalMessage = String(message || '');

  // Paid-tool approval re-entry is resolved before ordinary intent routing. This
  // prevents generic assistant wrappers or legacy 3-POC code from consuming an
  // approval that belongs to the universal deterministic spreadsheet domain.
  const paidApprovalResult = await resolveUniversalPaidApproval(originalMessage);
  if (paidApprovalResult) return paidApprovalResult;

  const resolvedMessage = normalize(originalMessage);
  const route = claim(originalMessage, options);
  require('./events').emit('command_route_decision', route);
  if (process.env.ULTRON_M3_ROUTE_DEBUG === '1') console.log('[Command Control]', JSON.stringify(route));
  if (!route.exclusive) return null;
  return scope.run({ route, compiler: false }, async () => {
    const spreadsheetDomain = ['three-poc-domain-controller', 'universal-spreadsheet-domain-controller'].includes(route.controller);
    const controller = route.controller === 'universal-spreadsheet-domain-controller'
      ? require('./universal-spreadsheet-domain-controller')
      : route.controller === 'three-poc-domain-controller'
        ? require('./three-poc-domain-controller')
        : route.controller === 'apollo-lead-domain-controller'
          ? require('./apollo-lead-domain-controller')
          : require('./linkedin-domain-controller');
    try {
      const result = await controller.handle(resolvedMessage, { ...options, originalMessage, resolvedMessage });
      if (scope.getStore().violation) throw scope.getStore().violation;
      return { ...result, route: route.domain, routing: route };
    } catch (error) {
      if (spreadsheetDomain) {
        const typedErrors = require('./spreadsheet-enrichment-errors');
        const typed = typedErrors.normalize(error, { stage: error?.stage || 'spreadsheet-controller-dispatch' });
        const diagnostic = typedErrors.format(typed);
        return {
          ok: false,
          text: `Universal spreadsheet control stopped safely: ${diagnostic}. ${typed.hint}`,
          response: `Universal spreadsheet control stopped safely: ${diagnostic}. ${typed.hint}`,
          error: typed.code,
          errorCode: typed.code,
          errorSubsystem: typed.subsystem,
          errorType: typed.type,
          errorStage: typed.stage,
          errorHint: typed.hint,
          errorMessage: typed.message,
          retryAttempts: typed.retryAttempts,
          attemptedRange: typed.attemptedRange || null,
          endpoint: typed.endpoint || null,
          providerStatus: typed.providerStatus ?? typed.status ?? null,
          executionContract: 'universal-coordinated-multi-poc-v4',
          model: 'mark3-universal-deterministic-enrichment',
          provider: 'local-spreadsheet-control',
          taskType: 'universal-sheet-enrichment',
          route: route.domain,
          routing: route,
        };
      }
      if (route.domain === 'apollo-lead') {
        return {
          ok: false,
          text: error.message,
          response: error.message,
          error: error.code || 'APOLLO_LEAD_CONTROLLER_FAILED',
          model: 'apollo-lead-intelligence',
          provider: 'apollo',
          taskType: 'apollo-lead-intelligence',
          route: 'apollo-lead',
          routing: route,
        };
      }
      return { ok: false, text: error.message, response: error.message, error: error.code || 'LINKEDIN_CONTROLLER_FAILED',
        model: 'linkedin-account-operator', provider: 'linkedin-account-mcp', taskType: 'linkedin-account-research', route: 'linkedin', routing: route };
    }
  });
}

module.exports = {
  normalize,
  spreadsheetSourceSignals,
  isThreePocSpreadsheetRequest,
  isUniversalSpreadsheetEnrichmentRequest,
  isLocalThreePocWorkbookRequest,
  claim,
  dispatch,
  resolveUniversalPaidApproval,
  assertAllowed,
  isInternalModelPayload,
  invariantCodeForDomain,
  runInternalInference,
  runExclusive,
  compileWithGemini,
};
