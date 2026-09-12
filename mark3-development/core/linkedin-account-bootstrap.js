const operator = require('./linkedin-account-operator');
const policy = require('./linkedin-account-policy');
const paidTools = require('./paid-tool-approval');
const config = require('./config');

let installed = false;
let originalHandle = null;

function responseShape(ok, text, extra = {}) {
  return {
    ok,
    response: text,
    text,
    model: 'linkedin-account-operator',
    provider: 'linkedin-account-mcp',
    taskType: 'linkedin-account-research',
    mode: 'operator',
    toolRounds: 0,
    ...extra,
  };
}

function isStatusRequest(text) {
  return /\blinkedin\s+(?:account\s+)?(?:scraper\s+|research\s+|tool\s+)?(?:status|health|doctor)\b/i.test(String(text || ''));
}

function isSetupRequest(text) {
  return /\blinkedin\s+(?:account\s+)?(?:setup|login|sign\s*in|authenticate|authentication)\b/i.test(String(text || ''));
}

function isUnlockRequest(text) {
  return /\blinkedin\s+(?:account\s+)?(?:unlock|clear\s+(?:the\s+)?lock|resume\s+after\s+(?:re-?login|verification))\b/i.test(String(text || ''));
}

function setupText() {
  return `LinkedIn account setup is explicit and local. Stop ULTRON, then run: cd "${config.mark3Root}" ; npm run linkedin:setup. Complete LinkedIn login/2FA/checkpoints yourself in the visible browser. ULTRON never needs your LinkedIn password.`;
}

function errorText(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || 'LinkedIn account research failed.');
  if (/LINKEDIN_MCP_NOT_INSTALLED|ENOENT/i.test(`${code} ${message}`)) {
    return 'LinkedIn-only research stopped before scraping because the local MCP runtime is unavailable. Install uv on Windows with: winget install --id=astral-sh.uv -e. Then run npm run linkedin:setup. No non-LinkedIn research fallback was used.';
  }
  if (/auth|login|session|LINKEDIN_JOEYISM_AUTH_REQUIRED/i.test(`${code} ${message}`)) {
    return `LinkedIn-only research stopped safely because the account session needs authentication. ${setupText()} No Google/Maps/TinyFish/Apollo fallback was used. Detail: ${message}`;
  }
  if (/LINKEDIN_MANUAL_LOCK/i.test(code) || error?.linkedinSafety?.kind === 'manual-lock') {
    return `LinkedIn-only research is locked because LinkedIn presented a security checkpoint/challenge. Complete manual re-authentication with npm run linkedin:setup, then send “LinkedIn account unlock”. ULTRON will not retry around a checkpoint. Detail: ${message}`;
  }
  if (/LINKEDIN_COOLDOWN|LINKEDIN_BURST_CAP|LINKEDIN_HOURLY_CAP|LINKEDIN_DAILY_CAP/i.test(code) || error?.linkedinSafety?.kind === 'rate-limit') {
    return `LinkedIn-only research stopped at the account-safety gate: ${message} ULTRON will not push through LinkedIn rate limits or switch to another source behind your back.`;
  }
  return `LinkedIn-only research stopped safely: ${message} No external lead source was substituted.`;
}

async function handlePrepared(prepared) {
  if (!prepared) return null;
  if (prepared.type === 'clarification') {
    return responseShape(true, prepared.text, { linkedinPending: true });
  }
  if (prepared.type === 'cancelled') {
    return responseShape(true, prepared.text, { linkedinCancelled: true });
  }
  if (prepared.type === 'run') {
    const mission = await operator.run(prepared.request, prepared.headers);
    let text = operator.formatMission(mission);
    const extra = {
      linkedinMission: mission,
      spreadsheetUrl: mission.sheetUrl,
    };
    if (mission.contactCandidates > 0 && mission.missingContacts > 0) {
      const approval = paidTools.request(
        'apollo',
        'linkedin-account-enrichment',
        { url: mission.sheetUrl, provider: 'google', ensureContactColumns: false, missionId: mission.id, entityMode: mission.request?.entityMode },
        mission.request?.entityMode === 'company'
          ? (mission.request?.hiring
            ? `LinkedIn company research is complete. Apollo would search these ${mission.contactCandidates} verified hiring companies, prioritize Talent Acquisition / HR heads and directors first, recruiting/HR managers second, recruiters third, and founder/owner only as fallback. It will enrich only one highest-priority person per company.`
            : `LinkedIn company research is complete. Apollo would search heads at these ${mission.contactCandidates} verified companies and enrich only one highest-priority person per company.`)
          : `LinkedIn people research is complete. Apollo would directly match these ${mission.contactCandidates} verified person profiles and fill missing phone/email cells.`
      );
      text += ` ${paidTools.prompt(approval)}`;
      extra.paidToolApproval = { id: approval.id, tool: approval.tool, operation: approval.operation, expiresAt: approval.expiresAt };
    }
    return responseShape(true, text, extra);
  }
  return null;
}

function install() {
  if (installed) return { installed: true, alreadyInstalled: true, ...operator.status() };
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
      const pending = await operator.resolvePending(text);
      if (pending) {
        conversation.append('user', text, { taskType: 'linkedin-account-layout', inputMode });
        result = await handlePrepared(pending);
      } else if (isStatusRequest(text)) {
        conversation.append('user', text, { taskType: 'linkedin-account-status', inputMode });
        result = responseShape(true, operator.statusText(), { linkedinAccount: operator.status() });
      } else if (isSetupRequest(text)) {
        conversation.append('user', text, { taskType: 'linkedin-account-setup-help', inputMode });
        result = responseShape(true, setupText(), { linkedinAccount: operator.status() });
      } else if (isUnlockRequest(text)) {
        conversation.append('user', text, { taskType: 'linkedin-account-unlock', inputMode });
        const safety = policy.clearManualLock('user explicitly confirmed LinkedIn account unlock after manual verification');
        result = responseShape(true, `LinkedIn account safety lock cleared by your explicit command. Current usage: ${safety.hourlyUsed}/${safety.hourlyMax} this hour and ${safety.dailyUsed}/${safety.dailyMax} today. Normal rate limits still apply.`, { linkedinSafety: safety });
      } else if (operator.isConsolidateRequest(text)) {
        conversation.append('user', text, { taskType: 'linkedin-account-consolidate', inputMode });
        const consolidated = await operator.consolidateVerifiedMissions(text);
        result = responseShape(true, `Consolidated ${consolidated.uniqueRecords} unique verified LinkedIn ${consolidated.entityMode === 'company' ? 'companies' : 'people'} from ${consolidated.missions} mission${consolidated.missions === 1 ? '' : 's'}. Added ${consolidated.added} row${consolidated.added === 1 ? '' : 's'}${consolidated.skippedDuplicates ? ` and skipped ${consolidated.skippedDuplicates} duplicate${consolidated.skippedDuplicates === 1 ? '' : 's'} already present` : ''}. ${consolidated.sheetUrl}`, {
          linkedinConsolidation: consolidated,
          spreadsheetUrl: consolidated.sheetUrl,
        });
      } else if (operator.isDedupeSheetRequest(text)) {
        conversation.append('user', text, { taskType: 'linkedin-account-sheet-dedupe', inputMode });
        const cleaned = await operator.dedupeWorkspaceSheet(text);
        result = responseShape(true, `Cleaned “${cleaned.spreadsheetTitle}” / ${cleaned.sheetName}: removed ${cleaned.removed} duplicate row${cleaned.removed === 1 ? '' : 's'}. ${cleaned.sheetUrl}`, {
          linkedinSheetDedupe: cleaned,
          spreadsheetUrl: cleaned.sheetUrl,
        });
      } else if (operator.isContinueSearchRequest(text)) {
        conversation.append('user', text, { taskType: 'linkedin-account-continuation', inputMode });
        const prepared = await operator.prepareContinuation(text);
        result = await handlePrepared(prepared);
      } else if (operator.isExistingSheetFillRequest(text)) {
        conversation.append('user', text, { taskType: 'linkedin-account-existing-sheet-fill', inputMode });
        const sheetUrl = require('./google-sheets-operator').extractSheetUrl(text) || operator.workspaceSheetUrl();
        const filled = await operator.fillLatestMissionIntoSheet(sheetUrl);
        result = responseShape(true, `Filled “${filled.spreadsheetTitle}” / ${filled.sheetName} with ${filled.added} verified LinkedIn row${filled.added === 1 ? '' : 's'}${filled.skippedDuplicates ? ` and skipped ${filled.skippedDuplicates} duplicate${filled.skippedDuplicates === 1 ? '' : 's'} already present` : ''}. ${filled.sheetUrl}`, {
          linkedinExistingSheetFill: filled,
          spreadsheetUrl: filled.sheetUrl,
        });
      } else if (operator.isRejectedSheetRequest(text)) {
        conversation.append('user', text, { taskType: 'linkedin-account-rejected-export', inputMode });
        const exported = await operator.createRejectedCandidatesSheet();
        if (exported.legacyMissing) {
          result = responseShape(true, `${exported.message} The previous “${exported.rejectedCandidates}” figure was a rejection count from that run, not a recoverable list of ${exported.rejectedCandidates} stored rows. Rerun the original LinkedIn mission once with this updated build; rejected candidates will then be retained and this same follow-up command will create their Sheet.`, {
            linkedinRejectedExport: exported,
          });
        } else {
          result = responseShape(true, `Created “${exported.spreadsheetTitle}” with ${exported.added} rejected LinkedIn candidate${exported.added === 1 ? '' : 's'}, including rejection reasons and the evidence used by the hard-filter gate. ${exported.sheetUrl}`, {
            linkedinRejectedExport: exported,
            spreadsheetUrl: exported.sheetUrl,
          });
        }
      } else {
        const request = operator.parseRequest(text);
        if (request) {
          conversation.append('user', text, {
            taskType: 'linkedin-account-research',
            inputMode,
            count: request.count,
            entityMode: request.entityMode,
            linkedinOnly: true,
          });
          emit('linkedin_account_research_requested', {
            count: request.count,
            entityMode: request.entityMode,
            location: request.location,
            linkedinOnly: true,
          });
          const prepared = await operator.prepare(request);
          result = await handlePrepared(prepared);
          emit(prepared.type === 'run' ? 'linkedin_account_research_completed' : 'linkedin_account_layout_requested', {
            entityMode: request.entityMode,
            count: request.count,
            spreadsheetUrl: result?.spreadsheetUrl || null,
          });
        }
      }
    } catch (error) {
      result = responseShape(false, errorText(error), {
        error: error.code || error.message,
        linkedinSafety: error.linkedinSafety || null,
      });
    }

    if (!result) return originalHandle(message, options);
    conversation.append('assistant', result.text, {
      model: result.model,
      provider: result.provider,
      taskType: result.taskType,
      inputMode,
      ok: result.ok,
    });
    void voice.enqueue(result.text);
    return { ...result, inputMode };
  };

  installed = true;
  return { installed: true, ...operator.status() };
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
  responseShape,
  isStatusRequest,
  isSetupRequest,
  isUnlockRequest,
  setupText,
  errorText,
  status: () => ({ installed, ...operator.status() }),
};
