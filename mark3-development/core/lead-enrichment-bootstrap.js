const sheets = require('./google-sheets-operator');
const microsoft = require('./microsoft-excel-operator');
const localExcel = require('./local-excel-operator');
const fileVault = require('./file-vault');
const leadEnrichment = require('./lead-enrichment-operator');
const leadResearch = require('./lead-research-operator');
const paidTools = require('./paid-tool-approval');

let installed = false;
let originalHandle = null;

function cleanUrl(value) {
  return String(value || '').trim().replace(/[),.;!?]+$/, '');
}

function localAttachmentSource(text, options = {}) {
  const current = Array.isArray(options.attachments) ? options.attachments.filter((item) => item?.id) : [];
  const explicitMention = /@[\w .()\-]{2,}/.test(String(text || ''));
  const candidates = current.length ? current : explicitMention ? fileVault.list(40) : [];
  return candidates.length ? localExcel.attachmentSource(candidates, text) : null;
}

function spreadsheetSource(text, options = {}) {
  const value = String(text || '').trim();
  const google = sheets.extractSheetUrl(value);
  if (google) return { provider: 'google', url: google, supported: true };

  const oneDrive = microsoft.extractWorkbookUrl(value);
  if (oneDrive) return { provider: 'microsoft', url: cleanUrl(oneDrive), supported: true };

  return localAttachmentSource(value, options);
}

function requestedContactFields(text) {
  const value = String(text || '');
  return {
    email: /\b(?:email|e\s*mail)\b/i.test(value),
    phone: /\b(?:phone|mobile|phone\s*number|contact\s*number|number)\b/i.test(value),
  };
}

function wantsContactColumns(text) {
  const value = String(text || '');
  const fields = requestedContactFields(value);
  const explicitColumns = /\b(?:make|add|create|ensure)\b[\s\S]{0,80}\bcolumns?\b/i.test(value) && (fields.email || fields.phone);
  const explicitBoth = fields.email && fields.phone && /\b(?:enrich|fill|populate|complete|add|update)\b/i.test(value);
  return explicitColumns || explicitBoth;
}

function hasEnrichmentIntent(text, options = {}) {
  const value = String(text || '').trim();
  const source = spreadsheetSource(value, options);
  const mentionsSheets = /\b(?:google\s+)?sheets?|spreadsheet|excel|workbook\b/i.test(value) || Boolean(source);
  const mentionsApollo = /\bapollo\b/i.test(value);
  const action = /\b(?:enrich|fill|populate|complete|find|get|add|update|phone|email|contact|lead)\b/i.test(value);
  const contactEnrichment = /\b(?:enrich|fill|populate|complete|add|update)\b/i.test(value)
    && /\b(?:email|e\s*mail|phone|mobile|number|contact)\b/i.test(value);
  return mentionsSheets && action && (mentionsApollo || contactEnrichment);
}

function isEnrichmentRequest(text, options = {}) {
  const value = String(text || '').trim();
  if (!hasEnrichmentIntent(value, options)) return null;
  const source = spreadsheetSource(value, options);
  if (!source) return { url: null, provider: null, invalidUrl: true, unsupportedProvider: null, ensureContactColumns: wantsContactColumns(value) };
  return {
    url: source.url,
    provider: source.provider,
    invalidUrl: false,
    unsupportedProvider: source.supported ? null : source.provider,
    ensureContactColumns: wantsContactColumns(value),
    attachment: source.attachment || null,
  };
}

function isStatusRequest(text) {
  return /\b(?:apollo|lead)\s+enrichment\s+status\b|\benrichment\s+status\b/i.test(String(text || ''));
}

function isResumeRequest(text) {
  return /\b(?:resume|continue|sync|check)\b[\s\S]{0,50}\b(?:apollo|lead|phone)\s+enrichment\b|\bresume\s+(?:today'?s\s+)?apollo\b/i.test(String(text || ''));
}

function statusText() {
  const state = leadEnrichment.status();
  const googleReady = Boolean(state.providers?.google);
  const microsoftReady = Boolean(state.providers?.microsoft);
  const localReady = Boolean(state.providers?.localExcel);
  const apolloReady = Boolean(state.apollo?.apiKeyReady && state.apollo?.webhookReady);
  return `Lead enrichment providers: Google Sheets ${googleReady ? 'ready' : 'not ready'}; Microsoft OneDrive/Excel ${microsoftReady ? 'ready' : 'not ready'}; attached Excel ${localReady ? 'ready' : 'not ready'}; Apollo ${apolloReady ? 'configured' : 'not fully configured'}. Pending phone checks: ${state.pendingPhones}. Explicit approval is mandatory before every new Apollo run.`;
}

function responseShape(ok, text, extra = {}) {
  return {
    ok,
    response: text,
    text,
    model: 'apollo-sheets-operator',
    provider: 'apollo+spreadsheet',
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
  return responseShape(true, paidTools.prompt(item), {
    model: 'apollo-approval-gate',
    provider: 'local-approval-gate',
    taskType: 'paid-tool-approval',
    paidToolApproval: { id: item.id, tool: item.tool, operation: item.operation, expiresAt: item.expiresAt },
    ...extra,
  });
}

function microsoftSetupResponse() {
  const state = microsoft.status();
  if (!state.dependencyReady) {
    return responseShape(false, 'OneDrive/Excel adapter is installed, Sir, but exceljs is missing. In mark3-development run: npm install. Apollo was not called.', {
      model: 'microsoft-excel-adapter', provider: 'local-microsoft-setup', error: 'MICROSOFT_EXCEL_DEPENDENCY_MISSING', apolloCalled: false,
    });
  }
  if (!state.clientIdReady) {
    return responseShape(false, 'OneDrive/Excel adapter is installed, Sir. Add MICROSOFT_GRAPH_CLIENT_ID to the root .env, then run: node --env-file=../.env scripts/microsoft-onedrive-setup.js. Apollo was not called.', {
      model: 'microsoft-excel-adapter', provider: 'local-microsoft-setup', error: 'MICROSOFT_GRAPH_CLIENT_ID_MISSING', apolloCalled: false,
    });
  }
  if (!state.authorized) {
    return responseShape(false, `${leadEnrichment.authInstruction('microsoft')} Apollo was not called.`, {
      model: 'microsoft-excel-adapter', provider: 'local-microsoft-setup', error: 'MICROSOFT_GRAPH_AUTH_REQUIRED', apolloCalled: false,
    });
  }
  return null;
}

function unsupportedSpreadsheetResponse(request) {
  const provider = request?.unsupportedProvider || request?.provider || 'unknown';
  return responseShape(false,
    `Spreadsheet provider ${provider} is not wired into ULTRON yet, Sir. I did not call Apollo and I did not edit the workbook.`,
    { model: 'mark3-spreadsheet-guard', provider: 'local-spreadsheet-guard', error: 'SPREADSHEET_ADAPTER_REQUIRED', spreadsheetProvider: provider, spreadsheetUrl: request?.url || null, apolloCalled: false }
  );
}

async function handleEnrichment(url, provider = null, options = {}) {
  try {
    const stats = await leadEnrichment.enrichSheet(url, { provider, ...options });
    const extra = { leadEnrichment: stats, spreadsheetProvider: stats.provider || provider || 'google' };
    if (stats.artifact) extra.artifacts = [stats.artifact];
    return responseShape(true, leadEnrichment.formatResult(stats), extra);
  } catch (error) {
    if (error.code === 'GOOGLE_SHEETS_AUTH_REQUIRED') {
      return responseShape(false, leadEnrichment.authInstruction('google'), { error: error.code });
    }
    if (error.code === 'GOOGLE_SHEETS_CREDENTIALS_MISSING') {
      return responseShape(false, `Google OAuth JSON is missing, Sir. Expected: ${require('./google-sheets-auth').status().credentialsPath}`, { error: error.code });
    }
    if (['MICROSOFT_GRAPH_AUTH_REQUIRED', 'MICROSOFT_GRAPH_CLIENT_ID_MISSING'].includes(error.code)) {
      return responseShape(false, `${leadEnrichment.authInstruction('microsoft')} Apollo was not called.`, { error: error.code, spreadsheetProvider: 'microsoft' });
    }
    if (error.code === 'MICROSOFT_EXCEL_DEPENDENCY_MISSING') {
      return responseShape(false, 'OneDrive Excel support needs exceljs. Run npm install in mark3-development, restart ULTRON, then retry. Apollo was not called.', { error: error.code, spreadsheetProvider: 'microsoft' });
    }
    if (['LOCAL_EXCEL_DEPENDENCY_MISSING', 'LOCAL_EXCEL_ATTACHMENT_NOT_FOUND', 'LOCAL_XLSX_REQUIRED'].includes(error.code)) {
      return responseShape(false, `Attached Excel enrichment stopped safely: ${error.message} Apollo was not called.`, { error: error.code, spreadsheetProvider: 'local-excel', apolloCalled: false });
    }
    if (error.code === 'MICROSOFT_WORKBOOK_CHANGED_DURING_RUN') {
      return responseShape(false, 'The Excel workbook changed while ULTRON was working, so the write was cancelled instead of overwriting someone else’s edits. Retry the enrichment after the workbook is idle.', { error: error.code, spreadsheetProvider: 'microsoft' });
    }
    if (error.code === 'PAID_TOOL_APPROVAL_REQUIRED') {
      return responseShape(false, 'Apollo was blocked because this run does not have explicit approval. Nothing was queried or charged.', { error: error.code });
    }
    return responseShape(false, `Lead enrichment stopped safely: ${error.message}`, { error: error.code || error.message, spreadsheetProvider: provider || null });
  }
}

async function handleResume() {
  try {
    const result = await leadEnrichment.resume();
    const text = result.resumed && result.stats
      ? leadEnrichment.formatResult(result.stats)
      : `Apollo phone sync checked, Sir. Resolved ${result.resolved || 0}; ${result.pending || 0} still pending.`;
    const extra = { leadEnrichment: result };
    if (result.stats?.artifact) extra.artifacts = [result.stats.artifact];
    return responseShape(true, text, extra);
  } catch (error) {
    if (error.code === 'GOOGLE_SHEETS_AUTH_REQUIRED') return responseShape(false, leadEnrichment.authInstruction('google'), { error: error.code });
    if (error.code === 'MICROSOFT_GRAPH_AUTH_REQUIRED') return responseShape(false, leadEnrichment.authInstruction('microsoft'), { error: error.code });
    if (error.code === 'PAID_TOOL_APPROVAL_REQUIRED') return responseShape(false, 'Apollo resume was blocked because this run does not have explicit approval.', { error: error.code });
    return responseShape(false, `Apollo enrichment resume failed safely: ${error.message}`, { error: error.code || error.message });
  }
}

async function handleResearch(requestData) {
  try {
    const result = await leadResearch.run(requestData);
    let text = leadResearch.formatResult(result);
    const extra = { leadResearch: result };

    if (result.wantsContactEnrichment && result.added > 0 && result.missingContacts > 0) {
      const apolloApproval = paidTools.request(
        'apollo',
        'lead-research-enrichment',
        { url: result.sheetUrl, provider: 'google' },
        `Research is already complete. Apollo would now check only missing phone/email fields in ${result.sheetName}, using existing sheet data and cache before any live Apollo call.`
      );
      text += ` ${paidTools.prompt(apolloApproval)}`;
      extra.paidToolApproval = { id: apolloApproval.id, tool: apolloApproval.tool, operation: apolloApproval.operation, expiresAt: apolloApproval.expiresAt };
    }
    return researchResponseShape(true, text, extra);
  } catch (error) {
    if (error.code === 'GOOGLE_SHEETS_AUTH_REQUIRED') return researchResponseShape(false, leadEnrichment.authInstruction('google'), { error: error.code });
    return researchResponseShape(false, `Lead research stopped safely: ${error.message}`, { error: error.code || error.message });
  }
}

async function handlePaidToolDecision(decision) {
  if (!decision) return null;
  if (decision.status === 'denied') {
    return responseShape(true, `${decision.label} was not used, Sir. The pending Apollo action was cancelled.`, {
      model: 'apollo-approval-gate', taskType: 'paid-tool-approval', provider: 'local-approval-gate', paidToolApproval: decision,
    });
  }

  if (decision.tool === 'apollo' && ['lead-enrichment', 'lead-research-enrichment', 'linkedin-account-enrichment'].includes(decision.operation)) {
    const ensureContactColumns = Boolean(decision.payload?.ensureContactColumns || decision.modifiers?.ensureContactColumns);
    return paidTools.withPermit(decision, () => handleEnrichment(decision.payload.url, decision.payload.provider || null, { ensureContactColumns }));
  }

  if (decision.tool === 'apollo' && decision.operation === 'lead-enrichment-resume') {
    return paidTools.withPermit(decision, () => handleResume());
  }

  return responseShape(false, `I received Apollo approval, Sir, but the pending operation is no longer valid. Nothing was executed.`, {
    model: 'apollo-approval-gate', taskType: 'paid-tool-approval', provider: 'local-approval-gate', error: 'STALE_PAID_TOOL_OPERATION',
  });
}

function providerDescription(provider) {
  if (provider === 'microsoft') return 'OneDrive/Excel workbook';
  if (provider === 'local-excel') return 'attached Excel workbook';
  return 'Google Sheet';
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
      const pendingApollo = paidTools.pending('apollo');
      if (pendingApollo && paidTools.approvalAttempt(text)) {
        conversation.append('user', text, { taskType: 'paid-tool-approval', inputMode, tool: 'apollo', decision: 'ambiguous' });
        result = responseShape(false,
          'Apollo approval is still pending, Sir. I did not send this command to Forge or another operator. Use “Approve Apollo” or “Approve and add phone and email columns”. Extra unrelated actions need a separate command.',
          { model: 'apollo-approval-gate', provider: 'local-approval-gate', taskType: 'paid-tool-approval', error: 'AMBIGUOUS_APOLLO_APPROVAL', apolloCalled: false }
        );
      } else {
        const researchRequest = leadResearch.parseRequest(text);
        if (researchRequest) {
          conversation.append('user', text, { taskType: 'lead-research', inputMode });
          if (researchRequest.invalidUrl) {
            result = researchResponseShape(false, 'Use the full Google Sheet link, Sir. I need the real spreadsheet ID after /d/ before I research or write any leads.', { error: 'INVALID_GOOGLE_SHEET_URL' });
          } else {
            emit('lead_research_started', { inputMode, count: researchRequest.count, criteria: researchRequest.criteria });
            result = await handleResearch(researchRequest);
            emit(result.ok ? 'lead_research_completed' : 'lead_research_failed', { inputMode, error: result.error || null });
          }
        } else {
          const request = isEnrichmentRequest(text, { attachments: options.attachments });
          if (request) {
            conversation.append('user', text, { taskType: 'lead-enrichment', inputMode, spreadsheetProvider: request.provider });
            if (request.unsupportedProvider) {
              result = unsupportedSpreadsheetResponse(request);
            } else if (request.invalidUrl) {
              result = responseShape(false, 'Use a full Google Sheets/OneDrive link or attach an Excel workbook and reference it with @filename. Nothing was queued and Apollo was not called.', { error: 'INVALID_SPREADSHEET_URL' });
            } else if (request.provider === 'microsoft' && microsoftSetupResponse()) {
              result = microsoftSetupResponse();
            } else {
              const approval = paidTools.request(
                'apollo',
                'lead-enrichment',
                { url: request.url, provider: request.provider, ensureContactColumns: request.ensureContactColumns },
                `I will use local spreadsheet/post details and the Apollo cache first, then make live Apollo calls only for fields that are still missing in this ${providerDescription(request.provider)}.`
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
  spreadsheetSource,
  localAttachmentSource,
  requestedContactFields,
  wantsContactColumns,
  hasEnrichmentIntent,
  isEnrichmentRequest,
  isStatusRequest,
  isResumeRequest,
  microsoftSetupResponse,
  unsupportedSpreadsheetResponse,
  handleEnrichment,
  handleResume,
  handleResearch,
  handlePaidToolDecision,
};
