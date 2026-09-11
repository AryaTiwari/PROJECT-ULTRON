const workspace = require('./lead-workspace-operator-v3');
const paidTools = require('./paid-tool-approval');

let installed = false;
let originalHandle = null;

function normalizeMissionCriteria(value) {
  const cleaned = String(value || '')
    .replace(/^(?:bring|find|get|source|collect|research|discover|scrape|build|generate|make)\s+(?:me\s+)?/i, '')
    .replace(/^\d{1,4}\s+/, '')
    .replace(/^(?:of|for)\s+/i, '')
    .replace(/\b(?:and|with|for|to)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'business professionals';
}

function implicitWorkspaceRequest(text) {
  const value = String(text || '').trim().replace(/^(?:hey\s+)?ultron\b[\s,:;.!-]*/i, '');
  const actionAndCount = /^(?:find|get|bring|research|source|collect|discover|scrape|build|generate|make)\s+(?:me\s+)?\d{1,4}\b/i.test(value);
  if (!actionAndCount) return null;

  const peopleOrLeadNoun = /\b(?:leads?|prospects?|contacts?|profiles?|founders?|co[- ]?founders?|owners?|recruiters?|hiring managers?|hr managers?|talent acquisition|managers?|creators?|decision makers?)\b/i.test(value);
  const mapsSource = /\b(?:google\s*maps?|maps?)\b/i.test(value)
    && /\b(?:business(?:es)?|companies|agencies|agency|gyms?|fitness studios?|clinics?|hospitals?|dentists?|doctors?|salons?|spas?|restaurants?|cafes?|hotels?|consultanc(?:y|ies)|real estate|realtors?|shops?|stores?|coaching|institutes?|schools?|colleges?|dietitians?|nutritionists?|law firms?|accountants?|coworking|studios?|photographers?|wedding planners?)\b/i.test(value);
  const jobSource = /\b(?:google jobs?|naukri|indeed|apna|workindia|job platforms?|job boards?)\b/i.test(value)
    && /\b(?:companies|business(?:es)?|employers?|organizations?|organisations?|recruiters?|hiring|jobs?|vacanc(?:y|ies)|roles?)\b/i.test(value);
  const linkedinSource = /\blinkedin\b/i.test(value)
    && /\b(?:companies|company|business(?:es)?|employers?|organizations?|organisations?|people|users?|profiles?|professionals?|recruiters?|founders?|owners?|managers?|employees?)\b/i.test(value);

  if (!peopleOrLeadNoun && !mapsSource && !jobSource && !linkedinSource) return null;
  const linkedinCompany = linkedinSource && /\b(?:companies|company|business(?:es)?|employers?|organizations?|organisations?)\b/i.test(value);
  const expanded = linkedinCompany
    ? `${value} and create a Google Sheet`
    : peopleOrLeadNoun
      ? `${value} and create a Google Sheet`
      : mapsSource
        ? `${value} and find founder owner or marketing decision maker leads and create a Google Sheet`
        : `${value} and find recruiter or talent acquisition leads and create a Google Sheet`;
  const parsed = workspace.parseRequest(expanded);
  if (parsed) parsed.originalMessage = value;
  return parsed;
}

function responseShape(ok, text, extra = {}) {
  return {
    ok,
    response: text,
    text,
    model: 'lead-workspace-v3',
    provider: 'source-fusion+public-web+google-sheets',
    taskType: 'lead-workspace',
    mode: 'operator',
    toolRounds: 0,
    ...extra,
  };
}

function approvalForMission(mission) {
  if (mission?.entityMode === 'company') return null;
  if (!mission?.sheetUrl || !mission?.wantsContactEnrichment || Number(mission.missingContacts || 0) <= 0) return null;
  return paidTools.request(
    'apollo',
    'lead-research-enrichment',
    { url: mission.sheetUrl, provider: 'google' },
    `The multi-source lead mission is complete. Apollo would now check only phone/email fields still missing in ${mission.sheetName || 'the new lead sheet'}, after public-source research, local sheet/post-detail recovery and cache checks.`
  );
}

function missionResponse(mission) {
  let text = workspace.formatMission(mission);
  const approval = approvalForMission(mission);
  const extra = { leadMission: mission, spreadsheetUrl: mission.sheetUrl };
  if (approval) {
    text += ` ${paidTools.prompt(approval)}`;
    extra.paidToolApproval = { id: approval.id, tool: approval.tool, operation: approval.operation, expiresAt: approval.expiresAt };
  }
  return responseShape(true, text, extra);
}

async function handlePrepared(prepared) {
  if (!prepared) return null;
  if (prepared.type === 'clarification') return responseShape(true, prepared.text, { leadWorkspacePending: prepared.pending || true });
  if (prepared.type === 'cancelled') return responseShape(true, prepared.text, { leadWorkspaceCancelled: true });
  if (prepared.type === 'run' && prepared.mission) return missionResponse(prepared.mission);
  return null;
}

function install() {
  if (installed) return { installed: true, alreadyInstalled: true, status: workspace.status() };
  const assistant = require('./assistant');
  const conversation = require('./conversation');
  const voice = require('./voice-orchestrator');
  const { emit } = require('./events');
  originalHandle = assistant.handle;

  assistant.handle = async (message, options = {}) => {
    const text = String(message || '').trim();
    const inputMode = String(options.inputMode || 'chat').toLowerCase() === 'voice' ? 'voice' : 'chat';
    let result = null;

    try {
      const pending = await workspace.resolvePending(text);
      if (pending) {
        conversation.append('user', text, { taskType: 'lead-workspace-layout', inputMode });
        emit('lead_workspace_layout_resolved', { inputMode, type: pending.type });
        result = await handlePrepared(pending);
      } else if (workspace.isLinkedInStatusRequest?.(text)) {
        conversation.append('user', text, { taskType: 'linkedin-public-research-status', inputMode });
        result = responseShape(true, workspace.linkedinStatusText(), { leadWorkspace: workspace.status() });
      } else if (workspace.isSourceStatusRequest?.(text)) {
        conversation.append('user', text, { taskType: 'lead-source-status', inputMode });
        result = responseShape(true, workspace.sourceStatusText(), { leadWorkspace: workspace.status() });
      } else if (workspace.isStatusRequest(text)) {
        conversation.append('user', text, { taskType: 'lead-workspace-status', inputMode });
        result = responseShape(true, workspace.statusText(), { leadWorkspace: workspace.status() });
      } else if (workspace.isResumeRequest(text)) {
        conversation.append('user', text, { taskType: 'lead-workspace-resume', inputMode });
        const resumed = await workspace.resumeLatestMission();
        if (!resumed.ok) result = responseShape(false, resumed.text, { leadWorkspace: workspace.status() });
        else if (resumed.alreadyComplete) result = responseShape(true, `The latest lead mission is already complete. ${workspace.statusText()}`, { leadMission: resumed.mission });
        else result = missionResponse(resumed.mission);
      } else {
        const request = workspace.parseRequest(text) || implicitWorkspaceRequest(text);
        if (request) {
          request.criteria = normalizeMissionCriteria(request.criteria);
          conversation.append('user', text, { taskType: 'lead-workspace', inputMode, count: request.count, criteria: request.criteria });
          emit('lead_workspace_requested', { inputMode, count: request.count, criteria: request.criteria });
          const prepared = await workspace.prepareRequest(request);
          result = await handlePrepared(prepared);
          emit(prepared.type === 'run' ? 'lead_workspace_completed' : 'lead_workspace_layout_requested', {
            inputMode,
            count: request.count,
            criteria: request.criteria,
            spreadsheetUrl: prepared.mission?.sheetUrl || null,
          });
        }
      }
    } catch (error) {
      const authError = ['GOOGLE_SHEETS_AUTH_REQUIRED', 'GOOGLE_SHEETS_CREDENTIALS_MISSING'].includes(error.code);
      const messageText = authError
        ? require('./lead-enrichment-operator').authInstruction('google')
        : `Lead Workspace stopped safely: ${error.message}`;
      result = responseShape(false, messageText, { error: error.code || error.message });
    }

    if (!result) return originalHandle(message, options);
    conversation.append('assistant', result.text, { model: result.model, provider: result.provider, taskType: result.taskType, inputMode, ok: result.ok });
    void voice.enqueue(result.text);
    return { ...result, inputMode };
  };

  installed = true;
  return { installed: true, status: workspace.status() };
}

function uninstall() {
  if (!installed) return;
  const assistant = require('./assistant');
  if (originalHandle) assistant.handle = originalHandle;
  originalHandle = null;
  installed = false;
}

module.exports = {
  install,
  uninstall,
  normalizeMissionCriteria,
  implicitWorkspaceRequest,
  responseShape,
  approvalForMission,
  missionResponse,
  status: () => ({ installed, ...workspace.status() }),
};
