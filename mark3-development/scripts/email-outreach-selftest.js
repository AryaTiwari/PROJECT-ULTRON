#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ultron-email-outreach-'));
process.env.ULTRON_M3_EMAIL_STATE_PATH = path.join(root, 'state.json');
process.env.ULTRON_M3_EMAIL_SMTP_HOST = 'smtp.example.test';
process.env.ULTRON_M3_EMAIL_SMTP_PORT = '587';
process.env.ULTRON_M3_EMAIL_SMTP_USER = 'sender@sender.test';
process.env.ULTRON_M3_EMAIL_SMTP_PASSWORD = 'super-secret-test-password';
process.env.ULTRON_M3_EMAIL_FROM = 'sender@sender.test';
process.env.ULTRON_M3_EMAIL_FROM_NAME = 'Elevate OS';
process.env.ULTRON_M3_EMAIL_DAILY_MAX = '10';
process.env.ULTRON_M3_EMAIL_MIN_GAP_MS = '0';
process.env.ULTRON_M3_EMAIL_SCHEDULER_ENABLED = '0';

const email = require('../core/email-outreach');
const bootstrap = require('../core/email-outreach-bootstrap');
const control = require('../core/command-control-plane');
const operator = require('../core/operator');

(async function () {
  assert.equal(email.cleanEmail(' Person@Example.com '), 'person@example.com');
  assert.equal(email.cleanEmail('not-an-email'), null);

  const recipient = email.normalizeRecipient({
    'APOLLO EMAIL': 'founder@acme.co',
    'APOLLO CONTACT': 'Riya Sharma',
    'COMPANY NAME': 'Acme India',
    'APOLLO ROLE': 'Founder',
    LOCATION: 'Mumbai',
  });
  assert.equal(recipient.first_name, 'Riya');
  assert.equal(recipient.company_name, 'Acme India');
  assert.equal(recipient.role, 'Founder');

  const rendered = email.renderTemplate(
    'Hi {{first_name|there}} from {{company_name}}. {% if role == "Founder" %}Founder note.{% else %}Team note.{% endif %} {{missing|fallback}}',
    recipient
  );
  assert.equal(rendered, 'Hi Riya from Acme India. Founder note. fallback');

  const deduped = email.dedupeRecipients([
    { email: 'ONE@real.co', name: 'One' },
    { email: 'one@real.co', name: 'Duplicate' },
    { email: 'bad value', name: 'Bad' },
    { email: 'two@real.co', name: 'Two' },
  ]);
  assert.equal(deduped.recipients.length, 2);
  assert.equal(deduped.invalidCount, 1);
  assert.equal(deduped.duplicateCount, 1);

  const saved = email.saveTemplate({
    name: 'Elevate intro',
    subject: 'Idea for {{company_name|your team}}',
    body: 'Hi {{first_name|there}},\nA personalized note for {{company_name|your team}}.',
    followups: [{ delayHours: 24, rule: 'not_replied', body: 'Hi {{first_name|there}}, following up briefly.' }],
  });
  assert.equal(saved.id, 'elevate_intro');

  const campaign = await email.prepareCampaign({
    name: 'Test campaign',
    templateName: 'Elevate intro',
    recipients: [
      { email: 'riya@acme.co', name: 'Riya Sharma', company_name: 'Acme India' },
      { email: 'sam@beta.co', name: 'Sam', company_name: 'Beta' },
    ],
  });
  assert.equal(campaign.status, 'awaiting_approval');
  assert.equal(email.previewCampaign(campaign.id, 1).previews[0].subject, 'Idea for Acme India');

  let blocked = false;
  try {
    await email.runCampaign(campaign.id, {
      transport: { sendMail: async function () { return { messageId: 'should-not-send' }; } },
      minGapMs: 0,
    });
  } catch (error) {
    blocked = error.code === 'EMAIL_CAMPAIGN_APPROVAL_REQUIRED';
  }
  assert.equal(blocked, true, 'Unapproved campaigns must never reach the transport.');

  email.approveCampaign(campaign.id);
  const sentTo = [];
  const mockTransport = {
    sendMail: async function (payload) {
      sentTo.push(payload.to);
      return { messageId: 'msg-' + sentTo.length, accepted: [payload.to], rejected: [] };
    },
  };
  const sent = await email.runCampaign(campaign.id, { transport: mockTransport, minGapMs: 0, dailyMax: 10 });
  assert.deepEqual(sentTo, ['riya@acme.co', 'sam@beta.co']);
  assert.equal(sent.stats.sent, 2);
  assert.equal(sent.status, 'active_followups');
  assert(sent.recipients.every(function (row) { return Boolean(row.delivery.messageId); }));

  const followup = await email.processFollowups({
    transport: mockTransport,
    nowMs: Date.now() + 26 * 60 * 60 * 1000,
    minGapMs: 0,
    dailyMax: 10,
  });
  assert.equal(followup.waitingReplyCheck, 2, 'Reply-aware follow-ups must wait when IMAP is unavailable.');

  assert(!JSON.stringify(email.status()).includes('super-secret-test-password'));
  assert.equal(email.status().approvalRequired, true);
  assert.equal(email.status().smtpConfigured, true);

  let capBlocked = false;
  try {
    await email.prepareCampaign({
      subject: 'x', body: 'y', maxRecipients: 1,
      recipients: [{ email: 'a@real.co' }, { email: 'b@real.co' }],
    });
  } catch (error) {
    capBlocked = error.code === 'EMAIL_CAMPAIGN_MAX_EXCEEDED';
  }
  assert.equal(capBlocked, true);

  assert(bootstrap.parseSaveTemplate('save email template "Test" subject: Hello {{first_name}} body: Hi {{first_name|there}}'));
  const followupCommand = bootstrap.parseAddFollowup('add email follow-up to template "Elevate intro" after 2 days if not replied subject: Quick follow-up body: Hi {{first_name|there}}, checking back.');
  assert.equal(followupCommand.delayHours, 48);
  assert.equal(followupCommand.rule, 'not_replied');
  const scheduledCommand = bootstrap.parsePrepareCampaign('prepare email campaign from Final Master using template "Elevate intro" schedule at 2026-09-20T10:00:00+05:30');
  assert.equal(scheduledCommand.finalMaster, true);
  assert.equal(scheduledCommand.scheduleAt, '2026-09-20T10:00:00+05:30');
  assert.equal(operator.match('prepare a personalized email campaign for my leads').id, 'email_outreach');

  const fromMaster = control.claim('prepare email campaign from LinkedIn Final Master using template "Elevate intro"');
  assert.equal(fromMaster.exclusive, false, 'Email delivery from a LinkedIn-named source must not be recaptured as LinkedIn research.');
  const discovery = control.claim('Find SAP companies on LinkedIn and build my lead list');
  assert.equal(discovery.exclusive, true, 'LinkedIn discovery must remain LinkedIn-exclusive.');

  console.log('Email Outreach self-test passed: personalization, dedupe, approval gating, receipts, caps, secret-safe status, reply-aware waiting and Final-Master routing are healthy.');
})().catch(function (error) {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
