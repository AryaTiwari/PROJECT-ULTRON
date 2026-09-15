'use strict';

const email = require('./email-outreach');

let installed = false;
let originalHandle = null;

function campaignId(text) {
  const match = String(text || '').match(/\b(email-\d+-[a-f0-9]+)\b/i);
  return match ? match[1] : null;
}

function isStatusRequest(text) {
  return /\b(?:email outreach|email system|email operator)\b[\s\S]{0,30}\b(?:status|ready|working|configured)\b/i.test(String(text || ''))
    || /^(?:email|smtp|imap)\s+status$/i.test(String(text || '').trim());
}

function isConnectionTest(text) {
  return /\b(?:test|check|verify)\b[\s\S]{0,40}\b(?:smtp|email)\b[\s\S]{0,30}\b(?:connection|credentials|account|configuration)\b/i.test(String(text || ''))
    || /\b(?:test|check|verify)\s+email\s+connection\b/i.test(String(text || ''));
}

function isListTemplates(text) {
  return /\b(?:list|show|view)\b[\s\S]{0,30}\bemail\s+templates?\b/i.test(String(text || ''));
}

function isListCampaigns(text) {
  return /\b(?:list|show|view)\b[\s\S]{0,30}\bemail\s+campaigns?\b/i.test(String(text || ''));
}

function isProcessFollowups(text) {
  return /\b(?:process|run|check|send)\b[\s\S]{0,40}\bemail\s+follow[- ]?ups?\b/i.test(String(text || ''));
}

function parseSaveTemplate(text) {
  const value = String(text || '').trim();
  if (!/\b(?:save|create|add)\b[\s\S]{0,25}\bemail\s+template\b/i.test(value)) return null;
  const name = value.match(/\bemail\s+template\s+["“']([^"”']+)["”']/i);
  const subject = value.match(/\bsubject\s*:\s*([\s\S]*?)(?=\s+\bbody\s*:)/i);
  const body = value.match(/\bbody\s*:\s*([\s\S]+)$/i);
  if (!name || !subject || !body) return { incomplete: true };
  return { name: name[1].trim(), subject: subject[1].trim(), body: body[1].trim() };
}

function parseAddFollowup(text) {
  const value = String(text || '').trim();
  if (!/\badd\b[\s\S]{0,25}\bemail\s+follow[- ]?up\b/i.test(value)) return null;
  const template = value.match(/\btemplate\s+["“']([^"”']+)["”']/i);
  const delay = value.match(/\bafter\s+(\d+)\s*(hours?|hrs?|days?)\b/i);
  const subject = value.match(/\bsubject\s*:\s*([\s\S]*?)(?=\s+\bbody\s*:)/i);
  const body = value.match(/\bbody\s*:\s*([\s\S]+)$/i);
  if (!template || !delay || !body) return { incomplete: true };
  const amount = Number(delay[1]);
  const delayHours = /day/i.test(delay[2]) ? amount * 24 : amount;
  const rule = /\b(?:if|when)\s+(?:they\s+)?(?:have\s+)?replied\b/i.test(value)
    ? 'replied'
    : /\b(?:if|when)\s+(?:they\s+)?(?:have\s+)?not\s+replied\b|\bno\s+reply\b/i.test(value)
      ? 'not_replied'
      : 'all';
  return {
    templateName: template[1].trim(),
    delayHours: delayHours,
    rule: rule,
    subject: subject ? subject[1].trim() : '',
    body: body[1].trim(),
  };
}

function parsePrepareCampaign(text) {
  const value = String(text || '').trim();
  if (!/\b(?:prepare|create|build|draft|start|send)\b[\s\S]{0,35}\b(?:personalized\s+)?email\s+campaign\b/i.test(value)
      && !/\bsend\s+personalized\s+emails?\b/i.test(value)) return null;
  if (campaignId(value)) return null;

  const template = value.match(/\busing\s+(?:the\s+)?template\s+["“']([^"”']+)["”']/i)
    || value.match(/\btemplate\s*:\s*["“']([^"”']+)["”']/i);
  const sheet = value.match(/https:\/\/docs\.google\.com\/spreadsheets\/d\/[^\s)]+/i);
  const finalMaster = /\b(?:canonical\s+)?(?:linkedin\s+)?final\s+master\b/i.test(value);
  const schedule = value.match(/\bschedule(?:d)?\s+(?:at|for)\s+([0-9TZ:+.-]{10,35})\b/i);
  return {
    templateName: template ? template[1].trim() : '',
    sheetUrl: sheet ? sheet[0] : '',
    finalMaster: finalMaster,
    scheduleAt: schedule ? schedule[1] : null,
    incomplete: !template || (!sheet && !finalMaster),
  };
}

function parsePreview(text) {
  const id = campaignId(text);
  return id && /\b(?:preview|show|review)\b[\s\S]{0,35}\bemail\s+campaign\b/i.test(String(text || '')) ? { id: id } : null;
}

function parseApproveOrSend(text) {
  const id = campaignId(text);
  if (!id) return null;
  const value = String(text || '');
  return /\b(?:approve|send|launch|start)\b[\s\S]{0,35}\bemail\s+campaign\b/i.test(value)
    || /\bemail\s+campaign\b[\s\S]{0,35}\b(?:approve|send|launch|start)\b/i.test(value) ? { id: id } : null;
}

function parseCancel(text) {
  const id = campaignId(text);
  return id && /\b(?:cancel|stop)\b[\s\S]{0,35}\bemail\s+campaign\b/i.test(String(text || '')) ? { id: id } : null;
}

function parseCampaignStatus(text) {
  const id = campaignId(text);
  if (!id) return null;
  const value = String(text || '');
  return /\bemail\s+campaign\b[\s\S]{0,35}\b(?:status|progress|state)\b|\b(?:status|progress|state)\b[\s\S]{0,35}\bemail\s+campaign\b/i.test(value)
    ? { id: id } : null;
}

function statusText() {
  const state = email.status();
  return 'Email Outreach Operator is installed. '
    + (state.smtpConfigured ? 'SMTP ready' : 'SMTP not configured') + '; '
    + (state.imapConfigured ? 'IMAP reply tracking ready' : 'IMAP reply tracking optional/not configured') + '. '
    + state.templates + ' saved template(s), ' + state.campaigns + ' campaign(s), ' + state.activeCampaigns + ' active. '
    + 'Preparing and previewing never sends. Delivery requires explicit approval.';
}

function formatCampaign(campaign) {
  return campaign.id + ' · ' + campaign.name + ' · ' + campaign.status
    + ' · recipients ' + campaign.stats.total
    + ' · sent ' + campaign.stats.sent
    + ' · failed ' + campaign.stats.failed
    + ' · pending ' + campaign.stats.pending
    + ' · follow-ups sent ' + Number(campaign.stats.followupsSent || 0);
}

async function handle(text) {
  const addFollowup = parseAddFollowup(text);
  if (addFollowup) {
    if (addFollowup.incomplete) {
      return { ok: false, text: 'Use: add email follow-up to template "Name" after 48 hours if not replied subject: Optional subject body: Follow-up message.' };
    }
    const existing = email.getTemplate(addFollowup.templateName);
    if (!existing) return { ok: false, text: 'Email template not found: ' + addFollowup.templateName, error: 'EMAIL_TEMPLATE_NOT_FOUND' };
    const updated = email.saveTemplate({
      name: existing.name,
      subject: existing.subject,
      body: existing.body,
      followups: (existing.followups || []).concat([{
        delayHours: addFollowup.delayHours,
        rule: addFollowup.rule,
        subject: addFollowup.subject,
        body: addFollowup.body,
      }]),
    });
    return { ok: true, text: 'Added follow-up ' + updated.followups.length + ' to "' + updated.name + '": after ' + addFollowup.delayHours + ' hour(s), rule ' + addFollowup.rule + '. Nothing was sent.', emailTemplate: updated };
  }

  const save = parseSaveTemplate(text);
  if (save) {
    if (save.incomplete) {
      return { ok: false, text: 'Use: save email template "Name" subject: Your subject body: Your message. Personalization fields include {{first_name|there}}, {{company_name}}, {{role}}, {{location}} and other sheet columns.' };
    }
    const template = email.saveTemplate(save);
    return { ok: true, text: 'Saved email template "' + template.name + '". Nothing was sent.', emailTemplate: template };
  }

  if (isListTemplates(text)) {
    const templates = email.listTemplates();
    const body = templates.length ? templates.map(function (item, index) {
      return (index + 1) + '. ' + item.name + ' [' + item.id + '] · ' + item.followups.length + ' follow-up(s)';
    }).join('\n') : 'No email templates are saved yet.';
    return { ok: true, text: body, emailTemplates: templates };
  }

  if (isListCampaigns(text)) {
    const campaigns = email.listCampaigns(20);
    const body = campaigns.length ? campaigns.map(function (item, index) {
      return (index + 1) + '. ' + formatCampaign(item);
    }).join('\n') : 'No email campaigns exist yet.';
    return { ok: true, text: body, emailCampaigns: campaigns };
  }

  if (isStatusRequest(text)) return { ok: true, text: statusText(), emailOutreach: email.status() };

  if (isConnectionTest(text)) {
    try {
      const result = await email.verifyTransport();
      return { ok: true, text: 'SMTP connection verified successfully. No email was sent.', emailConnection: result };
    } catch (error) {
      return { ok: false, text: 'Email connection check failed safely: ' + error.message, error: error.code || error.message };
    }
  }

  const preview = parsePreview(text);
  if (preview) {
    try {
      const result = email.previewCampaign(preview.id, 3);
      const samples = result.previews.map(function (item, index) {
        return '\n--- Preview ' + (index + 1) + ' ---\nTo: ' + item.to + '\nSubject: ' + item.subject + '\n' + item.body;
      }).join('\n');
      return { ok: true, text: 'Campaign ' + result.id + ' is ' + result.status + ' with ' + result.total + ' recipient(s).' + samples + '\n\nNothing was sent.', emailCampaignPreview: result };
    } catch (error) {
      return { ok: false, text: error.message, error: error.code || error.message };
    }
  }

  const cancel = parseCancel(text);
  if (cancel) {
    try {
      const campaign = email.cancelCampaign(cancel.id);
      return { ok: true, text: 'Cancelled ' + campaign.id + '. No further sends will run for it.', emailCampaign: campaign };
    } catch (error) {
      return { ok: false, text: error.message, error: error.code || error.message };
    }
  }

  const campaignStatus = parseCampaignStatus(text);
  if (campaignStatus) {
    try {
      const campaign = email.getCampaign(campaignStatus.id);
      return { ok: true, text: formatCampaign(campaign), emailCampaign: campaign };
    } catch (error) {
      return { ok: false, text: error.message, error: error.code || error.message };
    }
  }

  const approve = parseApproveOrSend(text);
  if (approve) {
    try {
      email.approveCampaign(approve.id);
      const campaign = await email.runCampaign(approve.id);
      return { ok: !['paused_error','partial'].includes(campaign.status), text: 'Email campaign executed. ' + formatCampaign(campaign) + '.', emailCampaign: campaign };
    } catch (error) {
      return { ok: false, text: 'Email campaign stopped safely: ' + error.message, error: error.code || error.message };
    }
  }

  if (isProcessFollowups(text)) {
    try {
      const result = await email.processFollowups();
      return { ok: true, text: 'Follow-up pass complete: checked ' + result.campaignsChecked + ', due ' + result.due + ', sent ' + result.sent + ', skipped ' + result.skipped + ', waiting for reply verification ' + result.waitingReplyCheck + ', failed ' + result.failures + '.', emailFollowups: result };
    } catch (error) {
      return { ok: false, text: 'Email follow-up pass stopped safely: ' + error.message, error: error.code || error.message };
    }
  }

  const prepare = parsePrepareCampaign(text);
  if (prepare) {
    if (prepare.incomplete) {
      return { ok: false, text: 'Specify a recipient source and saved template. Example: prepare email campaign from Final Master using template "Elevate intro". Nothing is sent until the resulting campaign ID is explicitly approved.' };
    }
    try {
      const campaign = await email.prepareCampaign(prepare);
      const previewResult = email.previewCampaign(campaign.id, 2);
      const sample = previewResult.previews.map(function (item, index) {
        return '\n--- Preview ' + (index + 1) + ' ---\nTo: ' + item.to + '\nSubject: ' + item.subject + '\n' + item.body;
      }).join('\n');
      return {
        ok: true,
        text: 'Prepared ' + formatCampaign(campaign) + '. Invalid email rows skipped: ' + campaign.invalidCount + '; duplicates removed: ' + campaign.duplicateCount + '.'
          + sample + '\n\nNO EMAILS WERE SENT. To send this prepared campaign: approve email campaign ' + campaign.id,
        emailCampaign: campaign,
        emailCampaignPreview: previewResult,
      };
    } catch (error) {
      return { ok: false, text: 'Email campaign preparation failed safely: ' + error.message, error: error.code || error.message };
    }
  }

  return null;
}

function isHandledIntent(text) {
  return Boolean(
    isStatusRequest(text) || isConnectionTest(text) || isListTemplates(text) || isListCampaigns(text)
    || isProcessFollowups(text) || parseAddFollowup(text) || parseSaveTemplate(text) || parsePrepareCampaign(text) || parsePreview(text)
    || parseApproveOrSend(text) || parseCancel(text) || parseCampaignStatus(text)
  );
}

function install() {
  if (installed) return { installed: true, alreadyInstalled: true, status: email.status() };
  const assistant = require('./assistant');
  const conversation = require('./conversation');
  const voice = require('./voice-orchestrator');
  const events = require('./events');
  originalHandle = assistant.handle;

  assistant.handle = async function (message, options) {
    options = options || {};
    const text = String(message || '').trim();
    if (!isHandledIntent(text)) return originalHandle(message, options);
    const inputMode = String(options.inputMode || 'chat').toLowerCase() === 'voice' ? 'voice' : 'chat';
    conversation.append('user', text, { taskType: 'email-outreach', inputMode: inputMode });
    events.emit('email_outreach_started', { inputMode: inputMode, command: text.slice(0, 160) });
    const result = await handle(text);
    if (!result) return originalHandle(message, options);
    conversation.append('assistant', result.text, { model: 'email-outreach', provider: 'smtp-local', taskType: 'email-outreach', inputMode: inputMode, ok: result.ok });
    events.emit(result.ok ? 'email_outreach_completed' : 'email_outreach_failed', { inputMode: inputMode, campaignId: result.emailCampaign && result.emailCampaign.id || null, error: result.error || null });
    void voice.enqueue(result.text);
    return Object.assign({
      response: result.text, model: 'email-outreach', provider: 'smtp-local',
      taskType: 'email-outreach', mode: 'operator', capability: 'email_outreach', inputMode: inputMode, toolRounds: 0,
    }, result);
  };

  installed = true;
  const scheduler = email.startScheduler();
  events.emit('email_outreach_ready', { status: email.status(), scheduler: scheduler });
  return { installed: true, status: email.status(), scheduler: scheduler };
}

function uninstall() {
  if (!installed) return;
  const assistant = require('./assistant');
  if (originalHandle) assistant.handle = originalHandle;
  email.stopScheduler();
  originalHandle = null;
  installed = false;
}

function status() { return { installed: installed, outreach: email.status() }; }

module.exports = {
  install, uninstall, status, handle, isHandledIntent, isStatusRequest, isConnectionTest,
  isListTemplates, isListCampaigns, isProcessFollowups, parseSaveTemplate, parseAddFollowup, parsePrepareCampaign,
  parsePreview, parseApproveOrSend, parseCancel, parseCampaignStatus, statusText, formatCampaign,
};
