'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const scope = new AsyncLocalStorage();

// Ownership precedes interpretation. No model, persistence or bootstrap import
// belongs in this module. HTTP dispatch does not depend on assistant wrappers.
function normalize(message) {
  return String(message || '').trim().replace(/^(?:hey\s+)?ultron\b[\s,:;.!-]*/i, '').replace(/\blinked\s+in\b/ig, 'LinkedIn');
}

function isLocalThreePocWorkbookRequest(message, options = {}) {
  const text = normalize(message);
  if (!text) return false;

  const attachments = Array.isArray(options.attachments) ? options.attachments : [];
  const hasExcelAttachment = attachments.some((item) => {
    const name = String(item?.name || item?.filename || '').trim();
    const mime = String(item?.mime || item?.mimeType || '').trim();
    return /\.xlsx?$/i.test(name)
      || /spreadsheetml|ms-excel/i.test(mime);
  });
  const hasMentionedWorkbook = /@[\w .()\-]{2,}/.test(text)
    && /\b(?:sheet|workbook|excel|3\s*[- ]?pocs?|three\s+pocs?|poc\s*[- ]?[123])\b/i.test(text);

  if (!hasExcelAttachment && !hasMentionedWorkbook) return false;

  const slotPatterns = [
    /\b(?:1st|first)\s+poc\b|\bpoc\s*[- ]?1\b/i,
    /\b(?:2nd|second)\s+poc\b|\bpoc\s*[- ]?2\b/i,
    /\b(?:3rd|third)\s+poc\b|\bpoc\s*[- ]?3\b/i,
  ];
  const slotCount = slotPatterns.filter((pattern) => pattern.test(text)).length;
  const explicitThreePoc = /\b(?:3\s*[- ]?pocs?|three\s+pocs?)\b/i.test(text);
  const anchoredContract = /\banchored(?:\s+legacy)?\b/i.test(text)
    || (/\bperson\s+or\s+company\s+name\b/i.test(text)
      && /\blinkedin\s+id\b/i.test(text)
      && slotCount >= 2);
  const action = /\b(?:perform|run|process|enrich|enrichment|fill|populate|complete|update|add|get|do)\b/i.test(text);

  return action && (explicitThreePoc || slotCount >= 2 || anchoredContract);
}

function claim(message, options = {}) {
  const text = normalize(message);
  if (isLocalThreePocWorkbookRequest(text, options)) {
    return Object.freeze({
      domain: 'local-three-poc',
      claimed: false,
      exclusive: false,
      controller: null,
      generalModelAllowed: true,
      artifactAllowed: true,
      allowWebFallback: true,
      yieldTo: 'lead-enrichment-bootstrap',
    });
  }
  const linkedin = /\blinkedin\b|linkedin\.com\/|\b(?:search_jobs|get_job_details|get_company_profile|search_companies|search_people|get_person_profile)\b/i.test(text);
  // Apollo contact enrichment belongs to the LinkedIn lead control plane even
  // when a conversational follow-up omits the word "LinkedIn".
  const apolloEnrichment = /\bapollo\b/i.test(text)
    && /\b(?:enrich|enrichment|email|e-?mail|phone|mobile|numbers?|contacts?|leads?|compan(?:y|ies)|sheet|master)\b/i.test(text);
  // A lead source may be named LinkedIn while the requested action is email delivery.
  // Keep discovery-first compound requests in LinkedIn, but let prepared email outreach
  // flow through the Email Outreach Operator instead of re-entering research.
  const emailOutreach = !apolloEnrichment
    && /\b(?:email outreach|email campaign|personalized emails?|send emails?|follow[- ]?up emails?)\b/i.test(text)
    && !/^\s*(?:find|search|research|discover|source|get)\b[\s\S]{0,100}\blinkedin\b/i.test(text);
  const operationalDomain = apolloEnrichment || (linkedin && !emailOutreach);
  // A report/status heading is not an artifact object. Require a concrete
  // format and a creation verb in the same clause, and ignore negated clauses.
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
function assertAllowed(kind, { model = '', messages = [] } = {}) {
  const current = scope.getStore();
  const lastUser = (Array.isArray(messages) ? messages : []).filter(item => item.role === 'user').at(-1)?.content;
  if (!current?.route.exclusive && !claim(typeof lastUser === 'string' ? lastUser : '').exclusive) return;
  if (kind === 'direct-model' && current?.compiler && /^gemini\//i.test(model)) return;
  const error = Object.assign(new Error(`LinkedIn exclusive route forbids ${kind}`), { code: 'LINKEDIN_ROUTE_INVARIANT_VIOLATION' });
  if (current) current.violation = error;
  console.error(error.code, JSON.stringify({ domain: 'linkedin', attempted: kind }));
  throw error;
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
async function dispatch(message, options = {}) {
  const originalMessage = String(message || '');
  const resolvedMessage = normalize(originalMessage);
  const route = claim(originalMessage, options);
  require('./events').emit('command_route_decision', route);
  if (process.env.ULTRON_M3_ROUTE_DEBUG === '1') console.log('[Command Control]', JSON.stringify(route));
  if (!route.exclusive) return null;
  return scope.run({ route, compiler: false }, async () => {
    const controller = require('./linkedin-domain-controller');
    try {
      const result = await controller.handle(resolvedMessage, { ...options, originalMessage, resolvedMessage });
      if (scope.getStore().violation) throw scope.getStore().violation;
      return { ...result, route: 'linkedin', routing: route };
    } catch (error) {
      return { ok: false, text: error.message, response: error.message, error: error.code || 'LINKEDIN_CONTROLLER_FAILED',
        model: 'linkedin-account-operator', provider: 'linkedin-account-mcp', taskType: 'linkedin-account-research', route: 'linkedin', routing: route };
    }
  });
}
module.exports = { normalize, isLocalThreePocWorkbookRequest, claim, dispatch, assertAllowed, runExclusive, compileWithGemini };
