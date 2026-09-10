const sheets = require('./google-sheets-operator');
const leadEnrichment = require('./lead-enrichment-operator');
const leadResearch = require('./lead-research-operator');
const paidTools = require('./paid-tool-approval');

let installed = false;
let originalHandle = null;

function hasEnrichmentIntent(text) {
  const value = String(text || '').trim();
  const mentionsSheets = /\b(?:google\s+)?sheets?|spreadsheet\b/i.test(value) || /docs\.google\.com\/spreadsheets/i.test(value);
  const mentionsApollo = /\bapollo\b/i.test(value);
  const action = /\b(?:enrich|fill|find|get|add|update|phone|email|contact|lead)\b/i.test(value);
  return mentionsSheets && mentionsApollo && action;
}

function isEnrichmentRequest(text) {
  const value = String(text || '').trim();
  if (!hasEnrichmentIntent(value)) return null;
  const url = sheets.extractSheetUrl(value);
  return { url, invalidUrl: !url };
}

function isStatusRequest(text) {
  return /\b(?:apollo|lead)\s+enrichment\s+status\b|\benrichment\s+status\b/i.test(String(text || ''));
}

function isResumeRequest(text) {
  return /\b(?:resume|continue|sync|check)\b[\s\S]{0,50}\b(?:apollo|lead|phone)\s+enrichment\b|\bresume\s+(?:today'?s\s+)?apollo\b/i.test(String(text || ''));
}

function statusText() {
  const state = leadEnrichment.status();
  const blockers = [];
  if (!state.apollo.apiKeyReady) blockers.push('Apollo API key');
  if (!state.apollo.webhookReady) blockers.push('Apollo webhook');
  if (!state.google.credentialsReady) blockers.push('Google OAuth JSON');
  if (!state.google.authorized) blockers.push('one-time Google login');
  if (blockers.length) return `Apollo + Sheets enrichment is installed, Sir. Still needed: ${blockers.join(', ')}. Pending phone checks: ${state.pendingPhones}. Paid-tool approval is mandatory before every new Apollo run.`;
  return `Apollo + Sheets enrichment is ready, Sir. Pending phone checks: ${state.pendingPhones}. Paid-tool approval is mandatory before every new Apollo run.`;
}

function responseShape(ok, text, extra = {}) {
  return {
    ok,
    response: text,
    text,
    model: 'apollo-sheets-operator',
    provider: 'apollo+google',
    taskType: 'lead-enrichment',
    mode: 'operator',
    toolRounds: 0,
    ...extra,
  };
}

function researchResponseShape(ok, text, extra = {}) {
  return {
    ok,
    response: text,
    text,
    model: 'lead-research-operator',
    provider: 'public-web+google',
    taskType: 'lead-research',
    mode: 'operator',
    toolRounds: 0,
    ...extra,
  };
}

function approvalResponse(item, extra = {}) {
  return researchResponseShape(true, paidTools.prompt(item), {
    taskType: 'paid-tool-approval',
    provider: 'local-approval-gate',
    paidToolApproval: { id: item.id, tool: item.tool, operation: item.operation, expiresAt: item.expiresAt },
    ...extra,
  });
}

async function handleEnrichment(url) {
  try {
    const stats = await leadEnrichment.enrichSheet(url);
    return responseShape(true, leadEnrichment.formatResult(stats), { leadEnrichment: stats });
  } catch (error) {
    if (error.code === 'GOOGLE_SHEETS_AUTH_REQUIRED') {
      return responseShape(false, leadEnrichment.authInstruction(), { error: error.code });
    }
    if (error.code === 'GOOGLE_SHEETS_CREDENTIALS_MISSING') {
      return responseShape(false, `Google OAuth JSON is missing, Sir. Expected: ${require('./google-sheets-auth').status().credentialsPath}`, { error: error.code });
    }
    if (error.code === 'PAID_TOOL_APPROVAL_REQUIRED') {
      return responseShape(false, 'Apollo was blocked because this run does not have explicit paid-tool approval. Nothing was queried or charged.', { error: error.code });
    }
    return responseShape(false, `Lead enrichment stopped safely: ${error.message}`, { error: error.code || error.message });
  }
}

async function handleResume() {
  try {
    const result = await leadEnrichment.resume();
    const text = result.resumed && result.stats
      ? leadEnrichment.formatResult(result.stats)
      : `Apollo phone sync checked, Sir. Resolved ${result.resolved || 0}; ${result.pending || 0} still pending.`;
    return responseShape(true, text, { leadEnrichment: result });
  } catch (error) {
    if (error.code === 'GOOGLE_SHEETS_AUTH_REQUIRED') return responseShape(false, leadEnrichment.authInstruction(), { error: error.code });
    if (error.code === 'PAID_TOOL_APPROVAL_REQUIRED') return responseShape(false, 'Apollo resume was blocked because this run does not have explicit paid-tool approval.', { error: error.code });
    return responseShape(false, `Apollo enrichment resume failed safely: ${error.message}`, { error: error.code || error.message });
  }
}

async function handleResearchApproval(decision) {
  try {
    const result = await paidTools.withPermit(decision, () => leadResearch.run(decision.payload));
    let text = leadResearch.formatResult(result);
    const extra = { leadResearch: result };

    if (result.wantsContactEnrichment && result.added > 0 && result.missingContacts > 0) {
      const apolloApproval = paidTools.request(
        'apollo',
        'lead-research-enrichment',
        { url: result.sheetUrl },
        `The public-research step is complete. Apollo would now check missing phone/email fields in ${result.sheetName}, using existing sheet data and cache before any live call.`
      );
      text += ` ${paidTools.prompt(apolloApproval)}`;
      extra.paidToolApproval = { id: apolloApproval.id, tool: apolloApproval.tool, operation: apolloApproval.operation, expiresAt: apolloApproval.expiresAt };
    }
    return researchResponseShape(true, text, extra);
  } catch (error) {
    if (error.code === 'GOOGLE_SHEETS_AUTH_REQUIRED') return researchResponseShape(false, leadEnrichment.authInstruction(), { error: error.code });
    if (error.code === 'PAID_TOOL_APPROVAL_REQUIRED') return researchResponseShape(false, 'The external research API was blocked because this run does not have explicit paid-tool approval.', { error: error.code });
    return researchResponseShape(false, `Lead research stopped safely: ${error.message}`, { error: error.code || error.message });
  }
}

async function handlePaidToolDecision(decision) {
  if (!decision) return null;
  if (decision.status === 'denied') {
    return researchResponseShape(true, `${decision.label} was not used, Sir. The pending paid-tool action was cancelled.`, {
      taskType: 'paid-tool-approval', provider: 'local-approval-gate', paidToolApproval: decision,
    });
  }

  if (decision.tool === 'tinyfish' && decision.operation === 'lead-research') {
    return handleResearchApproval(decision);
  }

  if (decision.tool === 'apollo' && ['lead-enrichment', 'lead-research-enrichment'].includes(decision.operation)) {
    return paidTools.withPermit(decision, () => handleEnrichment(decision.payload.url));
  }

  if (decision.tool === 'apollo' && decision.operation === 'lead-enrichment-resume') {
    return paidTools.withPermit(decision, () => handleResume());
  }

  return researchResponseShape(false, `I received approval for ${decision.label}, Sir, but the pending operation is no longer valid. Nothing was executed.`, {
    taskType: 'paid-tool-approval', provider: 'local-approval-gate', error: 'STALE_PAID_TOOL_OPERATION',
  });
}

function install() {
  if (installed) return { installed: true, alreadyInstalled: true, status: leadEnrichment.status(), approvals: paidTools.status() };
  const assistant = require('./assistant');
  const conversation = require('./conversation');
  const voice = require('./voice-orchestrator');
  const { emit } = require('./events');
  originalHandle = assistant.handle;
  paidTools.installApolloGuard();

  assistant.handle = async (message, options = {}) => {
    const text = String(message || '').trim();
    const inputMode = String(options.inputMode || 'chat').toLowerCase() === 'voice' ? 'voice' : 'chat';
    let result = null;

    const paidDecision = paidTools.resolveMessage(text);
    if (paidDecision) {
      conversation.append('user', text, { taskType: 'paid-tool-approval', inputMode, tool: paidDecision.tool, decision: paidDecision.status });
      result = await handlePaidToolDecision(paidDecision);
    } else {
      const researchRequest = leadResearch.parseRequest(text);
      if (researchRequest) {
        conversation.append('user', text, { taskType: 'lead-research', inputMode });
        if (researchRequest.invalidUrl) {
          result = researchResponseShape(false, 'Use the full Google Sheet link, Sir. I need the real spreadsheet ID after /d/ before I research or write any leads.', { error: 'INVALID_GOOGLE_SHEET_URL' });
        } else {
          const approval = paidTools.request(
            'tinyfish',
            'lead-research',
            researchRequest,
            `I will research up to ${researchRequest.count} public LinkedIn leads for “${researchRequest.criteria}” and append only new profiles to the Sheet. Apollo will remain blocked unless you separately approve it afterward.`
          );
          result = approvalResponse(approval, { leadResearchRequest: researchRequest });
        }
      } else {
        const request = isEnrichmentRequest(text);
        if (request) {
          conversation.append('user', text, { taskType: 'lead-enrichment', inputMode });
          if (request.invalidUrl) {
            result = responseShape(false, 'Use the full Google Sheet link, Sir. The URL must contain the real spreadsheet ID after /d/. Nothing was queued and the Sheet was not changed.', { error: 'INVALID_GOOGLE_SHEET_URL' });
          } else {
            const approval = paidTools.request(
              'apollo',
              'lead-enrichment',
              { url: request.url },
              'I will use the local Sheet/post details and Apollo cache first, then make live Apollo calls only for fields that are still missing.'
            );
            result = approvalResponse(approval, { leadEnrichmentRequest: request });
          }
        } else if (isResumeRequest(text)) {
          conversation.append('user', text, { taskType: 'lead-enrichment-resume', inputMode });
          const approval = paidTools.request(
            'apollo',
            'lead-enrichment-resume',
            {},
            'Resume can re-run missing enrichment after syncing existing webhook results, so Apollo remains blocked until this one-run approval is granted.'
          );
          result = approvalResponse(approval);
        } else if (isStatusRequest(text)) {
          conversation.append('user', text, { taskType: 'lead-enrichment-status', inputMode });
          result = responseShape(true, statusText(), { leadEnrichment: leadEnrichment.status(), paidTools: paidTools.status() });
        }
      }
    }

    if (!result) return originalHandle(message, options);
    conversation.append('assistant', result.text, { model: result.model, provider: result.provider, taskType: result.taskType, inputMode, ok: result.ok });
    void voice.enqueue(result.text);
    return { ...result, inputMode };
  };

  installed = true;
  if (leadEnrichment.pendingCount()) leadEnrichment.startPhoneWatcher();
  return { installed: true, status: leadEnrichment.status(), approvals: paidTools.status() };
}

function uninstall() {
  if (!installed) return;
  const assistant = require('./assistant');
  if (originalHandle) assistant.handle = originalHandle;
  originalHandle = null;
  installed = false;
}

function status() {
  return { installed, ...leadEnrichment.status(), paidTools: paidTools.status() };
}

module.exports = {
  install,
  uninstall,
  status,
  statusText,
  hasEnrichmentIntent,
  isEnrichmentRequest,
  isStatusRequest,
  isResumeRequest,
  handleEnrichment,
  handleResume,
  handlePaidToolDecision,
};
