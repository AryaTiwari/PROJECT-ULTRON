# Email Outreach Operator

ULTRON Mark 3 includes a native personalized-email campaign operator.

## Design origin and licensing boundary

The product behavior was informed by the public project PaulleDemon/Email-automation: dynamic templates, scheduled campaigns, follow-ups, SMTP sending, reply-aware rules, recipient dedupe and delivery tracking.

No source code from that project is copied or vendored into ULTRON. The reference project is AGPLv3 and its License.txt also adds commercial and distribution restrictions. ULTRON therefore implements the useful ideas independently in Node.js.

## Runtime flow

lead sheet / Final Master -> recipient normalization -> safe template rendering -> campaign prepared (NO SEND) -> preview -> explicit approval -> rate-limited SMTP delivery -> per-recipient receipts -> optional IMAP reply checks -> follow-ups

## Safety invariants

- Preparing or previewing never sends mail.
- Delivery requires explicit campaign approval.
- Recipient emails are validated and deduplicated.
- Default maximum is 50 recipients per campaign and 40 sent messages per day.
- Default send gap is 15 seconds.
- Repeated SMTP failures pause delivery.
- Reply-dependent follow-ups never guess. Without IMAP they remain waiting_reply_check.
- SMTP/IMAP passwords stay in environment variables and never enter state/status output.
- Attachments must remain inside PROJECT-ULTRON and are size-limited.

## Template grammar

Variables include {{first_name|there}}, {{company_name}}, {{role}}, {{location}} and any normalized sheet column.
Conditionals support {% if role %}...{% else %}...{% endif %} and simple equality checks.
The renderer does not use eval and cannot execute arbitrary JavaScript.

## Natural command examples

- email outreach status
- test email connection
- list email templates
- save email template "Elevate intro" subject: Creator growth for {{company_name}} body: Hi {{first_name|there}}, ...
- prepare email campaign from Final Master using template "Elevate intro"
- prepare email campaign from a Google Sheet URL using template "Elevate intro"
- preview email campaign email-...
- approve email campaign email-...
- email campaign email-... status
- cancel email campaign email-...
- process email followups

The canonical LinkedIn Final Master can be a recipient source without turning the email action into another LinkedIn discovery mission.