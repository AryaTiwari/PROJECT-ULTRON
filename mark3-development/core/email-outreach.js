'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const ROOT = path.join(config.projectRoot, '.ultron', 'email-outreach');
const STATE_FILE = path.resolve(process.env.ULTRON_M3_EMAIL_STATE_PATH || path.join(ROOT, 'state.json'));

function numberEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}
const SETTINGS = Object.freeze({
  campaignMax: Math.max(1, numberEnv('ULTRON_M3_EMAIL_CAMPAIGN_MAX', 50)),
  dailyMax: Math.max(1, numberEnv('ULTRON_M3_EMAIL_DAILY_MAX', 40)),
  minGapMs: Math.max(0, numberEnv('ULTRON_M3_EMAIL_MIN_GAP_MS', 15000)),
  maxConsecutiveFailures: Math.max(1, numberEnv('ULTRON_M3_EMAIL_MAX_CONSECUTIVE_FAILURES', 3)),
  schedulerEnabled: !/^(0|false|no|off)$/i.test(String(process.env.ULTRON_M3_EMAIL_SCHEDULER_ENABLED || '1')),
  schedulerIntervalMs: Math.max(30000, numberEnv('ULTRON_M3_EMAIL_SCHEDULER_INTERVAL_MS', 60000)),
  attachmentMaxBytes: Math.max(1024, numberEnv('ULTRON_M3_EMAIL_ATTACHMENT_MAX_BYTES', 10485760)),
  attachmentsTotalMaxBytes: Math.max(1024, numberEnv('ULTRON_M3_EMAIL_ATTACHMENTS_TOTAL_MAX_BYTES', 20971520)),
});

let scheduler = null;
function nowIso() { return new Date().toISOString(); }
function wait(ms) { return ms > 0 ? new Promise(function (resolve) { setTimeout(resolve, ms); }) : Promise.resolve(); }
function defaults() { return { version: 1, templates: {}, campaigns: {}, updatedAt: null }; }

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return defaults();
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return Object.assign(defaults(), parsed, {
      templates: parsed.templates || {},
      campaigns: parsed.campaigns || {},
    });
  } catch {
    return defaults();
  }
}
function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  state.updatedAt = nowIso();
  const temp = STATE_FILE + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  try { fs.chmodSync(temp, 0o600); } catch {}
  fs.renameSync(temp, STATE_FILE);
  try { fs.chmodSync(STATE_FILE, 0o600); } catch {}
  return state;
}

function cleanEmail(value) {
  const email = String(value || '').trim().toLowerCase().replace(/^mailto:/i, '');
  if (!email || email.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(email)) return null;
  if (/^(?:example|test|demo)@/i.test(email)) return null;
  return email;
}
function key(value) {
  return String(value || '').trim().toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
function first(object, names) {
  for (const name of names) {
    const value = object && object[name];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return '';
}
function remarkName(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const candidate = text.split(/\s+(?:[-–—|:]\s*|\(|,)\s*/)[0].trim();
  if (!candidate || candidate.length > 80 || /^(?:founder|director|owner|manager|recruiter|hr)\b/i.test(candidate)) return '';
  return candidate;
}
function normalizeRecipient(input) {
  const raw = {};
  for (const pair of Object.entries(input || {})) raw[key(pair[0])] = pair[1] == null ? '' : String(pair[1]).trim();
  const email = cleanEmail(first(raw, ['apollo_email','email','e_mail','work_email','business_email','contact_email','email_address']));
  if (!email) return null;
  const remarks = first(raw, ['remarks','remark','notes','note']);
  const name = first(raw, ['apollo_contact','contact_name','person_name','full_name','name','decision_maker']) || remarkName(remarks);
  const company = first(raw, ['company_name','company','organization','organisation','business_name']);
  const role = first(raw, ['apollo_role','role','title','job_title','position']);
  const firstName = name ? name.split(/\s+/)[0] : '';
  return Object.assign({}, raw, {
    email: email,
    name: name,
    first_name: firstName,
    firstName: firstName,
    company: company,
    company_name: company,
    companyName: company,
    role: role,
    remarks: remarks,
    phone: first(raw, ['apollo_phone','phone','mobile','phone_number']),
    company_link: first(raw, ['company_link','linkedin','linkedin_company','company_linkedin']),
    job_link: first(raw, ['job_link','job_url']),
  });
}
function dedupeRecipients(rows) {
  const seen = new Set();
  const recipients = [];
  let invalidCount = 0;
  let duplicateCount = 0;
  for (const row of rows || []) {
    const normalized = normalizeRecipient(row);
    if (!normalized) { invalidCount++; continue; }
    if (seen.has(normalized.email)) { duplicateCount++; continue; }
    seen.add(normalized.email);
    recipients.push(normalized);
  }
  return { recipients: recipients, invalidCount: invalidCount, duplicateCount: duplicateCount };
}

function contextMap(context) {
  const out = {};
  for (const pair of Object.entries(context || {})) {
    if (pair[1] == null || ['string','number','boolean'].includes(typeof pair[1])) out[key(pair[0])] = pair[1] == null ? '' : pair[1];
  }
  return out;
}
function condition(expression, context) {
  const match = String(expression || '').trim().match(/^([a-zA-Z0-9_. -]+?)(?:\s*(==|!=)\s*["']([^"']*)["'])?$/);
  if (!match) return false;
  const actual = String(context[key(match[1])] == null ? '' : context[key(match[1])]).trim();
  if (!match[2]) return Boolean(actual);
  return match[2] === '==' ? actual.toLowerCase() === match[3].toLowerCase() : actual.toLowerCase() !== match[3].toLowerCase();
}
function renderTemplate(template, context) {
  let output = String(template == null ? '' : template);
  const values = contextMap(context || {});
  const block = /{%\s*if\s+([^%]+?)\s*%}([\s\S]*?)(?:{%\s*else\s*%}([\s\S]*?))?{%\s*endif\s*%}/gi;
  for (let pass = 0; pass < 4; pass++) {
    block.lastIndex = 0;
    if (!block.test(output)) break;
    block.lastIndex = 0;
    output = output.replace(block, function (_all, expression, yes, no) {
      return condition(expression, values) ? yes : (no || '');
    });
  }
  return output.replace(/{{\s*([^{}|]+?)(?:\|([^{}]*?))?\s*}}/g, function (_all, rawKey, fallback) {
    const value = values[key(rawKey)];
    return value == null || String(value).trim() === '' ? String(fallback || '').trim() : String(value);
  });
}

function senderContext() {
  return {
    from_name: String(process.env.ULTRON_M3_EMAIL_FROM_NAME || 'ULTRON').trim(),
    from_email: String(process.env.ULTRON_M3_EMAIL_FROM || process.env.ULTRON_M3_EMAIL_SMTP_USER || '').trim(),
    from_signature: String(process.env.ULTRON_M3_EMAIL_SIGNATURE || '').trim(),
  };
}
function smtpConfig() {
  const port = Math.max(1, numberEnv('ULTRON_M3_EMAIL_SMTP_PORT', 587));
  return {
    host: String(process.env.ULTRON_M3_EMAIL_SMTP_HOST || '').trim(),
    port: port,
    secure: /^(1|true|yes|on)$/i.test(String(process.env.ULTRON_M3_EMAIL_SMTP_SECURE || (port === 465 ? '1' : '0'))),
    user: String(process.env.ULTRON_M3_EMAIL_SMTP_USER || '').trim(),
    pass: String(process.env.ULTRON_M3_EMAIL_SMTP_PASSWORD || '').trim(),
  };
}
function imapConfig() {
  return {
    host: String(process.env.ULTRON_M3_EMAIL_IMAP_HOST || '').trim(),
    port: Math.max(1, numberEnv('ULTRON_M3_EMAIL_IMAP_PORT', 993)),
    secure: !/^(0|false|no|off)$/i.test(String(process.env.ULTRON_M3_EMAIL_IMAP_SECURE || '1')),
    user: String(process.env.ULTRON_M3_EMAIL_IMAP_USER || process.env.ULTRON_M3_EMAIL_SMTP_USER || '').trim(),
    pass: String(process.env.ULTRON_M3_EMAIL_IMAP_PASSWORD || process.env.ULTRON_M3_EMAIL_SMTP_PASSWORD || '').trim(),
  };
}
function createTransport() {
  const cfg = smtpConfig();
  if (!cfg.host || !cfg.user || !cfg.pass) {
    const error = new Error('SMTP is not configured. Add ULTRON_M3_EMAIL_SMTP_HOST, ULTRON_M3_EMAIL_SMTP_USER and ULTRON_M3_EMAIL_SMTP_PASSWORD.');
    error.code = 'EMAIL_SMTP_NOT_CONFIGURED';
    throw error;
  }
  let nodemailer;
  try { nodemailer = require('nodemailer'); }
  catch {
    const error = new Error('nodemailer is not installed. Run npm install in mark3-development.');
    error.code = 'EMAIL_DEPENDENCY_MISSING';
    throw error;
  }
  return nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.secure, auth: { user: cfg.user, pass: cfg.pass },
    pool: false, connectionTimeout: 20000, greetingTimeout: 15000, socketTimeout: 30000,
  });
}
async function verifyTransport(transport) {
  const client = transport || createTransport();
  if (typeof client.verify !== 'function') return { ok: true, skipped: true };
  await client.verify();
  return { ok: true, skipped: false };
}

function normalizeFollowups(items) {
  return (Array.isArray(items) ? items : []).slice(0, 3).map(function (item, index) {
    const rawRule = String((item && item.rule) || 'not_replied').trim().toLowerCase().replace(/[\s-]+/g, '_');
    return {
      id: String((item && item.id) || ('followup_' + (index + 1))),
      delayHours: Math.max(1, Number((item && (item.delayHours || item.delay_hours)) || 48)),
      rule: ['all','not_replied','replied'].includes(rawRule) ? rawRule : 'not_replied',
      subject: String((item && item.subject) || '').trim(),
      body: String((item && item.body) || '').trim(),
    };
  }).filter(function (item) { return item.body; });
}
function templateId(name) { return key(name) || ('template_' + crypto.randomBytes(4).toString('hex')); }
function saveTemplate(input) {
  input = input || {};
  if (!String(input.name || '').trim()) throw new Error('Template name is required.');
  if (!String(input.subject || '').trim()) throw new Error('Template subject is required.');
  if (!String(input.body || '').trim()) throw new Error('Template body is required.');
  const state = loadState();
  const id = templateId(input.name);
  const previous = state.templates[id];
  state.templates[id] = {
    id: id, name: String(input.name).trim(), subject: String(input.subject), body: String(input.body),
    followups: normalizeFollowups(input.followups), createdAt: previous && previous.createdAt || nowIso(), updatedAt: nowIso(),
  };
  saveState(state);
  return state.templates[id];
}
function listTemplates() {
  return Object.values(loadState().templates || {}).sort(function (a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); });
}
function getTemplate(idOrName) {
  const state = loadState();
  const id = templateId(idOrName);
  if (state.templates[id]) return state.templates[id];
  const wanted = String(idOrName || '').trim().toLowerCase();
  return Object.values(state.templates).find(function (item) { return String(item.name || '').toLowerCase() === wanted; }) || null;
}

function normalizeAttachments(items) {
  const projectRoot = path.resolve(config.projectRoot);
  let total = 0;
  return (Array.isArray(items) ? items : []).map(function (item) {
    const resolved = path.resolve(projectRoot, String(item || ''));
    if (!(resolved === projectRoot || resolved.startsWith(projectRoot + path.sep))) throw new Error('Email attachments must stay inside the PROJECT-ULTRON workspace.');
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) throw new Error('Email attachment is not a file: ' + item);
    if (stat.size > SETTINGS.attachmentMaxBytes) throw new Error('Email attachment is too large: ' + item);
    total += stat.size;
    if (total > SETTINGS.attachmentsTotalMaxBytes) throw new Error('Email attachments exceed the configured total size limit.');
    return { filename: path.basename(resolved), path: resolved, bytes: stat.size };
  });
}

function findEmailColumn(headers) {
  const keys = headers.map(key);
  for (const wanted of ['apollo_email','email','e_mail','work_email','business_email','contact_email','email_address']) {
    const index = keys.indexOf(wanted);
    if (index >= 0) return index;
  }
  return -1;
}
async function recipientsFromSheet(sheetUrl, options) {
  options = options || {};
  const enrichment = require('./lead-enrichment-operator');
  const adapter = enrichment.adapterFor(sheetUrl, options.provider);
  const layout = await adapter.inspect(sheetUrl);
  const data = await adapter.readSheet(sheetUrl, layout);
  const headerRowIndex = Number.isInteger(layout.headerRowIndex) ? layout.headerRowIndex : Math.max(0, Number(layout.headerRowNumber || 1) - 1);
  const headers = data.rows[headerRowIndex] || [];
  const emailIndex = findEmailColumn(headers);
  if (emailIndex < 0) {
    const error = new Error('No usable Email/APOLLO EMAIL column was found in the lead sheet.');
    error.code = 'EMAIL_COLUMN_NOT_FOUND';
    throw error;
  }
  const rows = [];
  for (let rowIndex = headerRowIndex + 1; rowIndex < data.rows.length; rowIndex++) {
    const values = data.rows[rowIndex] || [];
    if (!String(values[emailIndex] || '').trim()) continue;
    const object = {};
    for (let column = 0; column < headers.length; column++) object[key(headers[column]) || ('column_' + (column + 1))] = values[column] == null ? '' : values[column];
    rows.push(object);
  }
  const result = dedupeRecipients(rows);
  result.source = {
    type: 'sheet', provider: adapter.provider || options.provider || 'google', sheetUrl: sheetUrl,
    sheetName: layout.sheetName, spreadsheetId: layout.spreadsheetId, spreadsheetTitle: layout.spreadsheetTitle, totalRows: rows.length,
  };
  return result;
}

async function prepareCampaign(options) {
  options = options || {};
  let source;
  if (Array.isArray(options.recipients)) {
    source = dedupeRecipients(options.recipients);
    source.source = { type: 'inline' };
  } else {
    let sheetUrl = String(options.sheetUrl || '').trim();
    if (!sheetUrl && options.finalMaster) sheetUrl = String(require('./linkedin-final-master').masterSheetUrl() || '').trim();
    if (!sheetUrl) {
      const error = new Error('A recipient list or lead-sheet URL is required.');
      error.code = 'EMAIL_RECIPIENT_SOURCE_REQUIRED';
      throw error;
    }
    source = await recipientsFromSheet(sheetUrl, { provider: options.provider });
  }
  const maxRecipients = Math.max(1, Number(options.maxRecipients || SETTINGS.campaignMax));
  if (source.recipients.length > maxRecipients) {
    const error = new Error('Campaign has ' + source.recipients.length + ' unique valid recipients; current safety maximum is ' + maxRecipients + '.');
    error.code = 'EMAIL_CAMPAIGN_MAX_EXCEEDED';
    throw error;
  }
  if (!source.recipients.length) {
    const error = new Error('No valid unique recipient emails were found.');
    error.code = 'EMAIL_RECIPIENTS_EMPTY';
    throw error;
  }
  const template = options.templateName || options.templateId ? getTemplate(options.templateName || options.templateId) : null;
  const subject = String(options.subject != null ? options.subject : (template && template.subject || '')).trim();
  const body = String(options.body != null ? options.body : (template && template.body || '')).trim();
  if (!subject || !body) {
    const error = new Error('Campaign subject and body are required, either inline or through a saved template.');
    error.code = 'EMAIL_TEMPLATE_REQUIRED';
    throw error;
  }
  const state = loadState();
  const id = 'email-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
  const createdAt = nowIso();
  state.campaigns[id] = {
    id: id,
    name: String(options.name || (template && template.name) || ('Email campaign ' + createdAt.slice(0, 10))).trim(),
    status: 'awaiting_approval', approvedAt: null, createdAt: createdAt, updatedAt: createdAt,
    scheduleAt: options.scheduleAt ? new Date(options.scheduleAt).toISOString() : null,
    subject: subject, body: body, templateId: template && template.id || null,
    followups: normalizeFollowups(options.followups != null ? options.followups : (template && template.followups || [])),
    attachments: normalizeAttachments(options.attachments || []), source: source.source,
    invalidCount: source.invalidCount || 0, duplicateCount: source.duplicateCount || 0,
    recipients: source.recipients.map(function (recipient) {
      return Object.assign({}, recipient, {
        delivery: { status: 'pending', attempts: 0, messageId: null, sentAt: null, error: null },
        followups: {}, repliedAt: null, replyCheckedAt: null,
      });
    }),
    stats: { total: source.recipients.length, sent: 0, failed: 0, pending: source.recipients.length, followupsSent: 0, skipped: 0 },
    lastError: null,
  };
  saveState(state);
  return state.campaigns[id];
}
function getCampaign(id) {
  const campaign = loadState().campaigns[String(id || '').trim()];
  if (!campaign) {
    const error = new Error('Email campaign not found: ' + id);
    error.code = 'EMAIL_CAMPAIGN_NOT_FOUND';
    throw error;
  }
  return campaign;
}
function listCampaigns(limit) {
  return Object.values(loadState().campaigns || {}).sort(function (a,b) { return String(b.createdAt).localeCompare(String(a.createdAt)); }).slice(0, Math.max(1, Number(limit || 20)));
}
function previewCampaign(id, limit) {
  const campaign = getCampaign(id);
  return {
    id: campaign.id, name: campaign.name, status: campaign.status, total: campaign.recipients.length,
    previews: campaign.recipients.slice(0, Math.max(1, Number(limit || 3))).map(function (recipient) {
      const context = Object.assign({}, senderContext(), recipient);
      return { to: recipient.email, name: recipient.name, company: recipient.company,
        subject: renderTemplate(campaign.subject, context), body: renderTemplate(campaign.body, context) };
    }),
  };
}
function approveCampaign(id) {
  const state = loadState();
  const campaign = state.campaigns[id];
  if (!campaign) return getCampaign(id);
  if (['completed','cancelled'].includes(campaign.status)) return campaign;
  campaign.approvedAt = nowIso();
  campaign.status = campaign.scheduleAt && Date.parse(campaign.scheduleAt) > Date.now() ? 'scheduled' : 'approved';
  campaign.updatedAt = nowIso();
  saveState(state);
  return campaign;
}
function cancelCampaign(id) {
  const state = loadState();
  const campaign = state.campaigns[id];
  if (!campaign) return getCampaign(id);
  campaign.status = 'cancelled';
  campaign.updatedAt = nowIso();
  saveState(state);
  return campaign;
}

function dateKey(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.ULTRON_M3_TIMEZONE || 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}
function sentToday(state, date) {
  state = state || loadState();
  date = date || new Date();
  const wanted = dateKey(date);
  let count = 0;
  for (const campaign of Object.values(state.campaigns || {})) {
    for (const recipient of campaign.recipients || []) {
      const stamps = [recipient.delivery && recipient.delivery.sentAt];
      for (const followup of Object.values(recipient.followups || {})) stamps.push(followup && followup.sentAt);
      for (const stamp of stamps) if (stamp && dateKey(new Date(stamp)) === wanted) count++;
    }
  }
  return count;
}
function fromHeader() {
  const name = String(process.env.ULTRON_M3_EMAIL_FROM_NAME || '').trim();
  const email = String(process.env.ULTRON_M3_EMAIL_FROM || process.env.ULTRON_M3_EMAIL_SMTP_USER || '').trim();
  return name && email ? '"' + name.replace(/"/g, '') + '" <' + email + '>' : email;
}
async function sendOne(transport, campaign, recipient, content) {
  const info = await transport.sendMail({
    from: fromHeader(), to: recipient.email,
    replyTo: String(process.env.ULTRON_M3_EMAIL_REPLY_TO || '').trim() || undefined,
    subject: content.subject, text: content.body,
    attachments: (campaign.attachments || []).map(function (item) { return { filename: item.filename, path: item.path }; }),
    headers: {
      'X-ULTRON-Campaign-ID': campaign.id,
      'X-ULTRON-Recipient': crypto.createHash('sha256').update(recipient.email).digest('hex').slice(0, 16),
    },
  });
  return { messageId: String(info && info.messageId || ''), accepted: info && info.accepted || [], rejected: info && info.rejected || [] };
}
async function runCampaign(id, options) {
  options = options || {};
  const state = loadState();
  const campaign = state.campaigns[id];
  if (!campaign) return getCampaign(id);
  if (!campaign.approvedAt) {
    const error = new Error('Campaign approval is required before any external email is sent.');
    error.code = 'EMAIL_CAMPAIGN_APPROVAL_REQUIRED';
    throw error;
  }
  if (campaign.status === 'cancelled') return campaign;
  const nowMs = Number(options.nowMs || Date.now());
  if (campaign.scheduleAt && Date.parse(campaign.scheduleAt) > nowMs) {
    campaign.status = 'scheduled'; campaign.updatedAt = nowIso(); saveState(state); return campaign;
  }
  const transport = options.transport || createTransport();
  const gap = Math.max(0, Number(options.minGapMs == null ? SETTINGS.minGapMs : options.minGapMs));
  const dailyMax = Math.max(1, Number(options.dailyMax || SETTINGS.dailyMax));
  const failureMax = Math.max(1, Number(options.maxConsecutiveFailures || SETTINGS.maxConsecutiveFailures));
  let dailyUsed = sentToday(state, new Date(nowMs));
  let consecutiveFailures = 0;
  campaign.status = 'sending'; campaign.updatedAt = nowIso(); saveState(state);

  for (let index = 0; index < campaign.recipients.length; index++) {
    const recipient = campaign.recipients[index];
    if (recipient.delivery && recipient.delivery.status === 'sent') continue;
    if (dailyUsed >= dailyMax) { campaign.status = 'paused_limit'; campaign.lastError = 'Daily email safety cap reached (' + dailyMax + ').'; break; }
    const context = Object.assign({}, senderContext(), recipient);
    recipient.delivery = recipient.delivery || { status: 'pending', attempts: 0 };
    recipient.delivery.attempts = Number(recipient.delivery.attempts || 0) + 1;
    try {
      const receipt = await sendOne(transport, campaign, recipient, {
        subject: renderTemplate(campaign.subject, context), body: renderTemplate(campaign.body, context),
      });
      recipient.delivery.status = 'sent'; recipient.delivery.messageId = receipt.messageId || null; recipient.delivery.sentAt = nowIso();
      recipient.delivery.error = null; recipient.delivery.accepted = receipt.accepted; recipient.delivery.rejected = receipt.rejected;
      campaign.stats.sent++; campaign.stats.pending = Math.max(0, campaign.stats.total - campaign.stats.sent - campaign.stats.failed);
      dailyUsed++; consecutiveFailures = 0; campaign.lastError = null;
    } catch (error) {
      recipient.delivery.status = 'failed'; recipient.delivery.error = String(error.message || error).slice(0, 1000);
      campaign.stats.failed++; campaign.stats.pending = Math.max(0, campaign.stats.total - campaign.stats.sent - campaign.stats.failed);
      consecutiveFailures++; campaign.lastError = recipient.delivery.error;
      if (consecutiveFailures >= failureMax) { campaign.status = 'paused_error'; break; }
    }
    campaign.updatedAt = nowIso(); saveState(state);
    if (gap && index < campaign.recipients.length - 1) await wait(gap);
  }
  if (campaign.status === 'sending') {
    const pending = campaign.recipients.some(function (recipient) { return !['sent','failed'].includes(recipient.delivery && recipient.delivery.status); });
    if (pending) campaign.status = 'partial';
    else if (campaign.followups.length && campaign.stats.sent > 0) campaign.status = 'active_followups';
    else campaign.status = campaign.stats.failed ? 'partial' : 'completed';
  }
  campaign.updatedAt = nowIso(); saveState(state);
  return campaign;
}

function imapReady() {
  const cfg = imapConfig();
  return Boolean(cfg.host && cfg.user && cfg.pass);
}
async function openImap() {
  const cfg = imapConfig();
  if (!cfg.host || !cfg.user || !cfg.pass) {
    const error = new Error('IMAP is not configured for reply-aware follow-ups.');
    error.code = 'EMAIL_IMAP_NOT_CONFIGURED';
    throw error;
  }
  let ImapFlow;
  try { ImapFlow = require('imapflow').ImapFlow; }
  catch {
    const error = new Error('imapflow is not installed. Run npm install in mark3-development.');
    error.code = 'EMAIL_DEPENDENCY_MISSING';
    throw error;
  }
  const client = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: { user: cfg.user, pass: cfg.pass }, logger: false });
  await client.connect();
  return client;
}
async function hasReply(email, since, suppliedClient) {
  const client = suppliedClient || await openImap();
  const owned = !suppliedClient;
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = await client.search({ from: email, since: new Date(since) });
      return Array.isArray(uids) && uids.length > 0;
    } finally { lock.release(); }
  } finally {
    if (owned) { try { await client.logout(); } catch {} }
  }
}
function previousStamp(recipient, index, campaign) {
  if (index === 0) return recipient.delivery && recipient.delivery.sentAt;
  const previous = campaign.followups[index - 1];
  const state = previous && recipient.followups && recipient.followups[previous.id];
  return state && (state.sentAt || state.skippedAt);
}
async function processFollowups(options) {
  options = options || {};
  const state = loadState();
  const active = Object.values(state.campaigns).filter(function (campaign) { return campaign.status === 'active_followups' && campaign.approvedAt; });
  const summary = { campaignsChecked: active.length, due: 0, sent: 0, skipped: 0, waitingReplyCheck: 0, failures: 0 };
  if (!active.length) return summary;
  const transport = options.transport || createTransport();
  const nowMs = Number(options.nowMs || Date.now());
  const gap = Math.max(0, Number(options.minGapMs == null ? SETTINGS.minGapMs : options.minGapMs));
  const dailyMax = Math.max(1, Number(options.dailyMax || SETTINGS.dailyMax));
  let dailyUsed = sentToday(state, new Date(nowMs));

  for (const campaign of active) {
    for (const recipient of campaign.recipients || []) {
      if (!recipient.delivery || recipient.delivery.status !== 'sent') continue;
      recipient.followups = recipient.followups || {};
      for (let index = 0; index < campaign.followups.length; index++) {
        const step = campaign.followups[index];
        const existing = recipient.followups[step.id];
        if (existing && existing.status && existing.status !== 'waiting_reply_check') continue;
        const prior = previousStamp(recipient, index, campaign);
        if (!prior) break;
        const dueAt = Date.parse(prior) + step.delayHours * 3600000;
        if (dueAt > nowMs) break;
        summary.due++;
        let replied = Boolean(recipient.repliedAt);
        if (step.rule !== 'all') {
          if (!imapReady() && !options.imapClient) {
            recipient.followups[step.id] = { status: 'waiting_reply_check', dueAt: new Date(dueAt).toISOString() };
            summary.waitingReplyCheck++; break;
          }
          try {
            replied = await hasReply(recipient.email, recipient.delivery.sentAt, options.imapClient || null);
            recipient.replyCheckedAt = nowIso();
            if (replied && !recipient.repliedAt) recipient.repliedAt = nowIso();
          } catch (error) {
            recipient.followups[step.id] = { status: 'waiting_reply_check', dueAt: new Date(dueAt).toISOString(), error: String(error.message || error).slice(0, 500) };
            summary.waitingReplyCheck++; break;
          }
          if ((step.rule === 'not_replied' && replied) || (step.rule === 'replied' && !replied)) {
            recipient.followups[step.id] = { status: 'skipped_rule', skippedAt: nowIso(), replied: replied };
            summary.skipped++; continue;
          }
        }
        if (dailyUsed >= dailyMax) { campaign.status = 'paused_limit'; campaign.lastError = 'Daily email safety cap reached (' + dailyMax + ').'; break; }
        const context = Object.assign({}, senderContext(), recipient);
        try {
          const receipt = await sendOne(transport, campaign, recipient, {
            subject: renderTemplate(step.subject || ('Re: ' + campaign.subject), context), body: renderTemplate(step.body, context),
          });
          recipient.followups[step.id] = { status: 'sent', sentAt: nowIso(), messageId: receipt.messageId || null, replied: replied };
          campaign.stats.followupsSent = Number(campaign.stats.followupsSent || 0) + 1; summary.sent++; dailyUsed++;
          if (gap) await wait(gap);
        } catch (error) {
          recipient.followups[step.id] = { status: 'failed', failedAt: nowIso(), error: String(error.message || error).slice(0, 1000) };
          summary.failures++;
        }
      }
    }
    const unfinished = campaign.recipients.some(function (recipient) {
      return recipient.delivery && recipient.delivery.status === 'sent' && campaign.followups.some(function (step) {
        const status = recipient.followups && recipient.followups[step.id] && recipient.followups[step.id].status;
        return !['sent','skipped_rule','failed'].includes(status);
      });
    });
    if (!unfinished && campaign.status === 'active_followups') campaign.status = campaign.stats.failed || summary.failures ? 'partial' : 'completed';
    campaign.updatedAt = nowIso();
  }
  saveState(state);
  return summary;
}

async function runDue() {
  const state = loadState();
  const current = Date.now();
  const due = Object.values(state.campaigns).filter(function (campaign) {
    return campaign.approvedAt && ['approved','scheduled','paused_limit'].includes(campaign.status) && (!campaign.scheduleAt || Date.parse(campaign.scheduleAt) <= current);
  });
  for (const campaign of due) { try { await runCampaign(campaign.id); } catch {} }
  try { await processFollowups(); } catch {}
}
function startScheduler() {
  if (scheduler || !SETTINGS.schedulerEnabled) return { started: Boolean(scheduler), enabled: SETTINGS.schedulerEnabled };
  scheduler = setInterval(function () { void runDue(); }, SETTINGS.schedulerIntervalMs);
  if (scheduler.unref) scheduler.unref();
  return { started: true, enabled: true, intervalMs: SETTINGS.schedulerIntervalMs };
}
function stopScheduler() { if (scheduler) clearInterval(scheduler); scheduler = null; }

function status() {
  const state = loadState();
  const smtp = smtpConfig();
  const imap = imapConfig();
  const campaigns = Object.values(state.campaigns || {});
  return {
    implemented: true,
    smtpConfigured: Boolean(smtp.host && smtp.user && smtp.pass),
    imapConfigured: Boolean(imap.host && imap.user && imap.pass),
    approvalRequired: true,
    schedulerEnabled: SETTINGS.schedulerEnabled,
    schedulerRunning: Boolean(scheduler),
    campaignMax: SETTINGS.campaignMax,
    dailyMax: SETTINGS.dailyMax,
    minGapMs: SETTINGS.minGapMs,
    templates: Object.keys(state.templates || {}).length,
    campaigns: campaigns.length,
    activeCampaigns: campaigns.filter(function (campaign) { return !['completed','cancelled'].includes(campaign.status); }).length,
    stateFile: STATE_FILE,
    transport: smtp.host ? { host: smtp.host, port: smtp.port, secure: smtp.secure, userConfigured: Boolean(smtp.user) } : null,
    replyTracking: imap.host ? { host: imap.host, port: imap.port, secure: imap.secure, userConfigured: Boolean(imap.user) } : null,
  };
}

module.exports = {
  ROOT, STATE_FILE, SETTINGS, loadState, saveState, cleanEmail, key, normalizeRecipient, dedupeRecipients,
  renderTemplate, senderContext, smtpConfig, imapConfig, createTransport, verifyTransport,
  saveTemplate, listTemplates, getTemplate, recipientsFromSheet, prepareCampaign, getCampaign, listCampaigns,
  previewCampaign, approveCampaign, cancelCampaign, sentToday, runCampaign, hasReply, processFollowups,
  runDue, startScheduler, stopScheduler, status,
};
