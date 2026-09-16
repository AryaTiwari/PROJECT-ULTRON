const operator = require('./linkedin-account-operator');
const policy = require('./linkedin-account-policy');
const paidTools = require('./paid-tool-approval');
const commandRouter = require('./linkedin-command-router');
const requestCompiler = require('./linkedin-request-compiler');
const config = require('./config');
const missionRunner = require('./linkedin-mission-runner');
const finalMaster = require('./linkedin-final-master');

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
  return /\blinkedin\s+(?:account\s+)?(?:mcp\s+|scraper\s+|research\s+|tool\s+)?(?:status|health|doctor)\b/i.test(String(text || ''));
}

function isSetupRequest(text) {
  return /\blinkedin\s+(?:account\s+)?(?:setup|login|sign\s*in|authenticate|authentication)\b/i.test(String(text || ''));
}

function isUnlockRequest(text) {
  return /\blinkedin\s+(?:account\s+)?(?:unlock|clear\s+(?:the\s+)?lock|resume\s+after\s+(?:re-?login|verification))\b/i.test(String(text || ''));
}

function isExplicitLinkedInOperationalIntent(text) {
  const value = String(text || '').trim();
  if (!/\blinkedin\b|linkedin\.com\//i.test(value)) return false;
  return /\b(?:find|get|search|research|source|scrape|collect|bring|list|show|extract|add|append|continue|resume|build|fill|edit|update|dedupe|consolidate|enrich|mission|progress|status|health|doctor|setup|login|authenticate|unlock|master|sheet|spreadsheet|companies?|jobs?|roles?|profiles?|recruiters?|mcp)\b/i.test(value);
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
  if (/GOOGLE_SHEETS_FORBIDDEN/i.test(code)) {
    return `LinkedIn research reached the Google Sheets destination but Google denied access to the master Sheet. Detail: ${message}. Share the Sheet with the Google account/service identity configured in ULTRON or set a different master Sheet; LinkedIn discovery itself is not the cause.`;
  }
  if (/GOOGLE_SHEETS_NOT_FOUND|GOOGLE_SHEETS_TAB_NOT_FOUND/i.test(code)) {
    return `The remembered master Sheet or tab no longer exists or is not visible to ULTRON. Detail: ${message}. Set a valid current/master Sheet and rerun; LinkedIn discovery itself is not the cause.`;
  }
  if (/GOOGLE_SHEETS_API_ERROR/i.test(code)) {
    return `Google Sheets rejected the destination operation: ${message}. ULTRON now expands narrow Sheet grids automatically and preserves verified LinkedIn results in a recovery Sheet when a master-Sheet write fails.`;
  }
  return `LinkedIn-only research stopped safely: ${message} No external lead source was substituted.`;
}

async function handlePrepared(prepared, background = false) {
  if (!prepared) return null;
  if (prepared.type === 'clarification') {
    return responseShape(true, prepared.text, { linkedinPending: true });
  }
  if (prepared.type === 'cancelled') {
    return responseShape(true, prepared.text, { linkedinCancelled: true });
  }
  if (prepared.type === 'run') {
    if (!background) {
      const job = missionRunner.enqueue(prepared);
      const text = job.alreadyActive
        ? `Matching LinkedIn mission ${job.id} is already ${job.status}. No duplicate mission was created. Ask “LinkedIn mission progress” for status.`
        : `LinkedIn mission queued: ${job.id}. Research runs in the background. Ask “LinkedIn mission progress” for status.`;
      return responseShape(true, text, { linkedinBackgroundMission: job });
    }
    const mission = await operator.run(prepared.request, prepared.headers);
    let text = operator.formatMission(mission);
    const extra = {
      linkedinMission: mission,
      spreadsheetUrl: mission.sheetUrl,
    };
    const explicitlyRequestedContacts = commandRouter.requestedContactEnrichment(mission.request?.originalMessage || '');
    if (explicitlyRequestedContacts && mission.contactCandidates > 0 && mission.missingContacts > 0) {
      const approval = paidTools.request(
        'apollo',
        'linkedin-account-enrichment',
        { url: mission.sheetUrl, provider: 'google', ensureContactColumns: false, missionId: mission.id, entityMode: mission.request?.entityMode },
        mission.request?.entityMode === 'company'
          ? (mission.request?.hiring
            ? `LinkedIn company research is complete. Apollo would search these ${mission.contactCandidates} verified hiring companies, prioritize Founder/Director/Owner first, Head Recruiter or hiring/recruitment/HR Manager second, HR Recruiter third. It will enrich only one highest-priority person per company.`
            : `LinkedIn company research is complete. Apollo would search these ${mission.contactCandidates} verified companies using the canonical Founder/Director/Owner > Head Recruiter/Manager > HR Recruiter scale and enrich only one highest-priority person per company.`)
          : `LinkedIn people research is complete. Apollo would directly match these ${mission.contactCandidates} verified person profiles and fill missing phone/email cells.`
      );
      text += ` ${paidTools.prompt(approval)}`;
      extra.paidToolApproval = { id: approval.id, tool: approval.tool, operation: approval.operation, expiresAt: approval.expiresAt };
    }
    return responseShape(true, text, extra);
  }
  return null;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function missionProgressText(job) {
  const p = job?.progress || {};
  const parts = [
    `LinkedIn mission ${job.id}: ${job.status}`,
    `Calls: ${job.calls}`,
    `cached results reused: ${job.cacheHits}`,
  ];
  if (p.phase) parts.push(`phase: ${p.phase}`);
  if (Number.isFinite(Number(p.uniqueJobIds))) parts.push(`unique jobs: ${p.uniqueJobIds}`);
  if (Number.isFinite(Number(p.jobDetailsChecked))) parts.push(`job details: ${p.jobDetailsChecked}`);
  if (Number.isFinite(Number(p.companyProfilesChecked))) parts.push(`company profiles: ${p.companyProfilesChecked}`);
  if (Number.isFinite(Number(p.verifiedCompanies))) parts.push(`verified companies this batch: ${p.verifiedCompanies}`);
  if (Number.isFinite(Number(job.elapsedMs))) parts.push(`elapsed: ${formatDuration(job.elapsedMs)}`);
  if (Number.isFinite(Number(job.activeWorkMs))) parts.push(`active work: ${formatDuration(job.activeWorkMs)}`);
  if (Number.isFinite(Number(job.addedSinceStart))) parts.push(`rows added since start: ${job.addedSinceStart}`);
  if (Number.isFinite(Number(job.avgActiveMsPerCompany)) && job.avgActiveMsPerCompany > 0) parts.push(`avg active time/new company: ${formatDuration(job.avgActiveMsPerCompany)}`);
  if (Number.isFinite(Number(job.estimatedActiveMsRemaining)) && job.estimatedActiveMsRemaining >= 0) parts.push(`estimated active work remaining: ${formatDuration(job.estimatedActiveMsRemaining)}`);
  if (job.lastProgressAt) parts.push(`last Sheet progress: ${job.lastProgressAt}`);
  if (Number.isFinite(Number(job.batchCount))) parts.push(`batches: ${job.batchCount}`);
  if (Number.isFinite(Number(job.masterCurrent))) parts.push(`Final Master total: ${job.masterCurrent}`);
  if (Number.isFinite(Number(job.masterRemaining))) parts.push(`remaining to target: ${job.masterRemaining}`);
  if (!Number.isFinite(Number(job.masterRemaining)) && Number.isFinite(Number(p.remaining))) parts.push(`remaining this run: ${p.remaining}`);
  if (Number.isFinite(Number(p.durableCompanyProfileHits))) parts.push(`durable company profiles reused: ${p.durableCompanyProfileHits}`);
  if (Number.isFinite(Number(p.budgetUsed)) && Number.isFinite(Number(p.budgetMaximum))) {
    parts.push(`safe-call budget: ${p.budgetUsed}/${p.budgetMaximum}`);
  }
  if (Number.isFinite(Number(p.cachedReconsidered))) parts.push(`cached candidates reconsidered: ${p.cachedReconsidered}`);
  if (Number.isFinite(Number(p.cachedJobDetailHits))) parts.push(`cached job details reused: ${p.cachedJobDetailHits}`);
  if (Number.isFinite(Number(p.cachedJobDetailMisses))) parts.push(`job details still needing live verification: ${p.cachedJobDetailMisses}`);
  if (Number.isFinite(Number(p.cachedCompanyProfileHits))) parts.push(`cached company profiles reused: ${p.cachedCompanyProfileHits}`);
  if (Number.isFinite(Number(p.cachedCompanyProfileMisses))) parts.push(`company profiles still needing live verification: ${p.cachedCompanyProfileMisses}`);
  if (p.cacheVerificationExhausted) parts.push('all reusable verification evidence has been scanned');
  if (p.nextEligibleAt) parts.push(`next safe resume: ${p.nextEligibleAt}`);
  if (p.safetyReason) parts.push(`waiting reason: ${p.safetyReason}`);
  if (job.error?.message && !p.safetyReason) parts.push(job.error.message);
  return parts.join('. ') + '.';
}

function missionContractText(job) {
  const contract = job?.contract;
  if (!contract) return 'This LinkedIn mission does not have a compiled mission contract.';
  const hard = contract.hard || {};
  const preferences = contract.preferences || {};
  const target = contract.target || {};
  const hardParts = [];
  if (hard.topic) hardParts.push('topic=' + hard.topic);
  if (hard.hiringRequired) hardParts.push('verified opening required');
  if (Array.isArray(hard.locations) && hard.locations.length) hardParts.push('allowed locations=' + hard.locations.join(', '));
  if (hard.employeeMin != null) hardParts.push('employees>=' + hard.employeeMin);
  if (hard.employeeMax != null) hardParts.push('employees<=' + hard.employeeMax);
  if (hard.workType) hardParts.push('work type=' + hard.workType);
  const preferenceParts = [];
  if (Array.isArray(preferences.locations) && preferences.locations.length) preferenceParts.push('location order=' + preferences.locations.join(' -> '));
  if (preferences.workType) preferenceParts.push('work type=' + preferences.workType);
  return [
    'LinkedIn mission contract ' + job.id + '.',
    'Target: ' + (target.mode || 'additional') + ' ' + (target.value ?? 'unknown') + '.',
    'Hard constraints: ' + (hardParts.join('; ') || 'none') + '.',
    'Preferences: ' + (preferenceParts.join('; ') || 'none') + '.',
    'Global repeat policy: ' + (contract.dedupe?.allowPreviouslySeen ? 'previously seen companies allowed' : 'previously seen companies excluded') + '.',
    contract.relaxation?.hardConstraintsLocked ? 'Hard constraints are locked unless you explicitly change them.' : '',
  ].filter(Boolean).join(' ');
}

let initialized = false;
function initialize() {
  if (initialized) return;
  const conversation = require('./conversation');
  missionRunner.start(prepared => require('./command-control-plane').runExclusive(async () => {
    const result = await handlePrepared(prepared, true);
    conversation.append('assistant', result.text, { taskType: 'linkedin-account-research', model: result.model, ok: result.ok });
    return result;
  }));
  initialized = true;
}
async function handle(message, options = {}) {
  initialize();
  const conversation = require('./conversation');
  const voice = require('./voice-orchestrator');
  const { emit } = require('./events');
    const text = String(message || '').trim();
    const inputMode = String(options.inputMode || 'chat').toLowerCase() === 'voice' ? 'voice' : 'chat';
    let result = null;

    // Attached/local 3-POC workbook enrichment is owned by lead-enrichment-bootstrap.
    // "LinkedIn Id" is a column identity signal here, not a request for the LinkedIn
    // account research/Apollo-columns workflow.
    if (require('./command-control-plane').isThreePocSpreadsheetRequest(text, options)) return null;

    try {
      if (/^\s*(?:resume\b[\s\S]*\blinkedin\b|continue\b[\s\S]*[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})/i.test(text)) {
        const job = missionRunner.resumeSaved(text);
        const message = job.alreadyActive
          ? `LinkedIn mission ${job.id} is already active. No duplicate mission was created.`
          : job.recovered
            ? `The original LinkedIn mission state ${job.missingMissionId} is missing from the current mission store. I created recovery continuation ${job.id} from ${job.recoverySourceMissionIds?.length || 0} compatible saved mission source(s), covering ${job.compatibleSearchResponses || 0} cached search_jobs response(s) and ${job.compatibleCachedResponses || 0} cached tool response(s). Fresh discovery is disabled for this recovery pass.`
            : `Resuming saved LinkedIn mission ${job.id}. Existing discovery responses will be reused; no fresh discovery searches will be made.`;
        return responseShape(true, message, { linkedinBackgroundMission: job });
      }
      if (/\blinkedin mission (?:progress|pause|cancel|resume|explain)\b/i.test(text)) {
        const targetId = String(text).match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/i)?.[0] || null;
        let selected = null;
        if (targetId) {
          try { selected = missionRunner.get(targetId); } catch {}
        } else {
          selected = missionRunner.active() || missionRunner.list()[0] || null;
        }
        if (!selected) return responseShape(false, targetId
          ? `LinkedIn mission ${targetId} was not found in the current mission store.`
          : 'No background LinkedIn mission exists yet.', {
            error: targetId ? 'LINKEDIN_MISSION_NOT_FOUND' : 'LINKEDIN_MISSION_NONE',
            requestedMissionId: targetId,
          });
        const action = text.match(/\blinkedin mission (progress|pause|cancel|resume|explain)\b/i)[1].toLowerCase();
        const job = action === 'progress'
          ? await missionRunner.refreshSheetProgress(selected.id)
          : action === 'explain'
            ? missionRunner.summary(selected)
            : missionRunner.control(selected.id, action);
        const terminalResult = ['completed', 'partial', 'failed', 'cancelled'].includes(job.status) ? job.result?.text : null;
        return responseShape(true, action === 'explain' ? missionContractText(job) : (terminalResult || missionProgressText(job)), { linkedinBackgroundMission: job });
      }
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
      } else if (commandRouter.isApolloEnrichmentRequest(text)) {
        conversation.append('user', text, { taskType: 'linkedin-apollo-enrichment-request', inputMode });

        const latest = operator.latestCompletedMission();
        const workspaceUrl = operator.workspaceSheetUrl();
        const masterUrl = finalMaster.masterSheetUrl();
        const explicitSheetUrl = commandRouter.sheetUrlFromText(text) || null;
        const explicitlyMaster = /\b(?:final\s+master|master\s+sheet|canonical\s+master)\b/i.test(text);
        const preferredSheetUrl = explicitSheetUrl || workspaceUrl || null;

        let approval = null;
        let targetUrl = null;
        let entityMode = null;

        if (masterUrl && (explicitlyMaster || preferredSheetUrl === masterUrl)) {
          targetUrl = masterUrl;
          entityMode = 'company';
          approval = paidTools.request(
            'apollo',
            'linkedin-final-master-enrichment',
            { url: masterUrl, provider: 'google', entityMode: 'company' },
            'Apollo will scan every company row currently present in the canonical Final Master, including manually pasted rows, and write results only into the dedicated APOLLO CONTACT / ROLE / LINKEDIN / PHONE / EMAIL / STATUS section.'
          );
        } else if (preferredSheetUrl || latest?.sheetUrl) {
          targetUrl = preferredSheetUrl || latest.sheetUrl;
          const matchingMission = latest?.sheetUrl === targetUrl ? latest : null;
          entityMode = matchingMission?.request?.entityMode || 'company';
          approval = paidTools.request(
            'apollo',
            'linkedin-account-enrichment',
            {
              url: targetUrl,
              provider: 'google',
              ensureContactColumns: false,
              missionId: matchingMission?.id || null,
              entityMode,
            },
            entityMode === 'company'
              ? 'Apollo will scan every company row currently in this Sheet, including rows pasted manually or added by older missions, select one verified priority contact per incomplete company, and write only to the dedicated Apollo columns.'
              : 'This people-based Sheet will enrich the exact LinkedIn person stored in each row. ULTRON will not substitute a different company contact.'
          );
        } else if (masterUrl) {
          targetUrl = masterUrl;
          entityMode = 'company';
          approval = paidTools.request(
            'apollo',
            'linkedin-final-master-enrichment',
            { url: masterUrl, provider: 'google', entityMode: 'company' },
            'Apollo will scan every company row currently present in the canonical Final Master and use the dedicated Apollo enrichment section.'
          );
        }

        if (!approval) {
          result = responseShape(false, 'Apollo enrichment needs a current LinkedIn mission Sheet or the canonical Final Master. No Apollo call was made.', {
            error: 'LINKEDIN_APOLLO_TARGET_NOT_FOUND',
            apolloCalled: false,
          });
        } else {
          result = responseShape(true, paidTools.prompt(approval), {
            paidToolApproval: { id: approval.id, tool: approval.tool, operation: approval.operation, expiresAt: approval.expiresAt },
            spreadsheetUrl: targetUrl,
            linkedinApolloEntityMode: entityMode,
            apolloCalled: false,
          });
        }
      } else if (operator.isBuildFinalMasterRequest(text)) {
        conversation.append('user', text, { taskType: 'linkedin-final-master-build', inputMode });
        const built = await operator.buildFinalMaster(text);
        result = responseShape(true,
          built.alreadyExists
            ? `The canonical LinkedIn Final Master already exists with ${built.uniqueRecords} verified unique companies. ${built.sheetUrl}`
            : `Built the canonical LinkedIn Final Master from historical verified company missions. Added ${built.added} clean unique company rows and excluded person-profile contamination/unverified rows. Future company research will use global company dedupe by default. ${built.sheetUrl}`,
          { linkedinFinalMaster: built, spreadsheetUrl: built.sheetUrl }
        );
      } else if (commandRouter.isSetWorkspaceRequest(text)) {
        conversation.append('user', text, { taskType: 'linkedin-account-workspace-sheet', inputMode });
        const sheetUrl = commandRouter.sheetUrlFromText(text);
        const sheet = await commandRouter.inspectSheet(sheetUrl);
        operator.rememberWorkspaceSheet(sheetUrl, {
          sheetName: sheet.sheetName,
          spreadsheetTitle: sheet.spreadsheetTitle,
          entityMode: operator.status()?.workspace?.entityMode || null,
        });
        result = responseShape(true, `Set “${sheet.spreadsheetTitle}” / ${sheet.sheetName} as the current LinkedIn workspace Sheet. Future commands can say “current Sheet”, “master Sheet” or “consolidated Sheet”. ${sheetUrl}`, {
          linkedinWorkspaceSheet: sheet,
          spreadsheetUrl: sheetUrl,
        });
      } else if (commandRouter.isSheetEditRequest(text, operator.workspaceSheetUrl())) {
        conversation.append('user', text, { taskType: 'linkedin-account-sheet-edit', inputMode });
        const edited = await commandRouter.executeSheetEdit(text, operator.workspaceSheetUrl());
        operator.rememberWorkspaceSheet(edited.sheetUrl, {
          sheetName: edited.sheetName,
          spreadsheetTitle: edited.spreadsheetTitle,
          entityMode: operator.status()?.workspace?.entityMode || null,
        });
        result = responseShape(true, `Updated “${edited.spreadsheetTitle}” / ${edited.sheetName}: ${edited.operation} ${edited.changed.join(', ')}. ${edited.sheetUrl}`, {
          linkedinSheetEdit: edited,
          spreadsheetUrl: edited.sheetUrl,
        });
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
        const message = cleaned.deletionApproved
          ? `Cleaned “${cleaned.spreadsheetTitle}” / ${cleaned.sheetName}: removed ${cleaned.removed} duplicate row${cleaned.removed === 1 ? '' : 's'} after explicit deletion approval. ${cleaned.sheetUrl}`
          : `Checked “${cleaned.spreadsheetTitle}” / ${cleaned.sheetName}: found ${cleaned.duplicatesFound} duplicate row${cleaned.duplicatesFound === 1 ? '' : 's'}. Nothing was deleted because the command did not explicitly ask to delete/remove duplicates. ${cleaned.sheetUrl}`;
        result = responseShape(true, message, {
          linkedinSheetDedupe: cleaned,
          spreadsheetUrl: cleaned.sheetUrl,
        });
      } else if (commandRouter.isMissionRefinementRequest(text, operator.latestCompletedMission())) {
        conversation.append('user', text, { taskType: 'linkedin-account-refinement', inputMode });
        const sourceMission = operator.latestCompletedMission();
        const refinement = commandRouter.buildMissionRefinement(text, sourceMission, operator.workspaceSheetUrl());
        if (!refinement || !refinement.request) {
          result = responseShape(false, 'LinkedIn refinement could not be parsed safely, so the previous mission was left unchanged.');
        } else if (refinement.satisfied) {
          result = responseShape(true, 'The requested LinkedIn target is already satisfied in the latest mission; no additional search was started.', {
            linkedinRefinement: refinement,
            spreadsheetUrl: sourceMission.sheetUrl || operator.workspaceSheetUrl(),
          });
        } else {
          const prepared = await operator.prepare(refinement.request);
          result = await handlePrepared(prepared);
          if (result) {
            result.linkedinRefinement = refinement;
          }
        }
      } else if (operator.isContinueSearchRequest(text)) {
        conversation.append('user', text, { taskType: 'linkedin-account-continuation', inputMode });
        const prepared = await operator.prepareContinuation(text);
        if (prepared?.request) {
          prepared.request.wantsContacts = commandRouter.requestedContactEnrichment(text);
        }
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
        let parsed = operator.parseRequest(text);
        let compilerResult = null;

        // Deterministic parsing remains primary. The bounded Gemini compiler is
        // only a rescue path for explicit LinkedIn research phrasing the grammar
        // did not understand. It never executes research and never routes through
        // Nemotron/OmniRoute.
        if (!parsed && requestCompiler.shouldCompile(text)) {
          compilerResult = await requestCompiler.compile(text);
          if (compilerResult.ok && compilerResult.canonicalPrompt) {
            parsed = operator.parseRequest(compilerResult.canonicalPrompt);
            if (parsed) {
              parsed.originalMessage = text;
              parsed.compiler = {
                mode: 'typed-gemini-rescue',
                model: compilerResult.model,
                provider: compilerResult.provider,
                canonicalPrompt: compilerResult.canonicalPrompt,
              };
            }
          }
        }

        const request = commandRouter.enhanceRequest(parsed, text, operator.workspaceSheetUrl());
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
            compiler: request.compiler || compilerResult || null,
          });
          const prepared = await operator.prepare(request);
          result = await handlePrepared(prepared);
          emit(prepared.type === 'run' ? 'linkedin_account_research_queued' : 'linkedin_account_layout_requested', {
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

    if (!result && isExplicitLinkedInOperationalIntent(text)) {
      result = responseShape(false,
        'LinkedIn command was claimed by the dedicated operator but could not be compiled safely. General model routing was not invoked. Use “LinkedIn account status” to verify MCP health, or restate the LinkedIn operation with the target, filters and desired count.',
        {
          linkedinRouteGuard: true,
          reason: 'linkedin_command_uncompiled_fail_closed',
          linkedinCompiler: requestCompiler.hasGeminiCredential() ? 'typed-gemini-rescue-available' : 'deterministic-only-gemini-not-configured',
        }
      );
    }
    if (!result) return null;
    conversation.append('assistant', result.text, {
      model: result.model,
      provider: result.provider,
      taskType: result.taskType,
      inputMode,
      ok: result.ok,
    });
    void voice.enqueue(result.text);
    return { ...result, inputMode };
}

function install() {
  if (installed) return { installed: true, alreadyInstalled: true, ...operator.status() };
  initialize();
  const assistant = require('./assistant');
  originalHandle = assistant.handle;
  // Compatibility for non-HTTP callers and implicit workspace follow-ups.
  // HTTP ownership invokes the domain controller directly, never this adapter.
  assistant.handle = async (message, options = {}) => {
    const claimed = await require('./command-control-plane').dispatch(message, options);
    if (claimed) return claimed;
    const result = await handle(message, options);
    return result || originalHandle(message, options);
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
  initialize,
  handle,
  uninstall,
  responseShape,
  isStatusRequest,
  isSetupRequest,
  isUnlockRequest,
  isExplicitLinkedInOperationalIntent,
  setupText,
  errorText,
  status: () => ({ installed, ...operator.status() }),
};
