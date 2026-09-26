---
name: lead-research-delivery
description: End-to-end job/company research with decision-maker enrichment and Google Sheet delivery. Use for requests combining hiring/job discovery, company contacts, phone/email enrichment, and spreadsheet output.
---

# Lead research delivery

Treat requests like “find SAP roles, get founder/recruiter contacts, and send me a sheet” as one persistent outcome.

1. Parse the requested geography, role family, company constraints, contact fields and output format.
2. Create a mission when the work is multi-step or must survive an auth/rate-limit interruption.
3. Read the native lead master before fresh discovery and reuse verified evidence.
4. Discover jobs/companies using the user's requested source constraints. Do not confuse generic search snippets with verified final evidence.
5. Save accepted companies to `ultron_lead_master_upsert`. One company remains one canonical lead.
6. Treat the existing LinkedIn profile URL as POC 1. Do not create a redundant POC 1 name column in the sheet. Store POC 1's phone/email and its CURRENT company from the profile.
7. Search POC 2 and POC 3 inside POC 1's CURRENT company, even when that differs from the job company. Exclude POC 1 from those results. Prefer Founder/CEO/Director/Owner, then Co-Founder/Recruiting Head/Manager/HR Manager/Recruiter. Never invent missing phone/email.
8. Apollo Organization Search is the preferred native source when the user explicitly requests Apollo company discovery. Use `ultron_apollo_search_organizations` for company candidates. Apollo People Search remains the POC/contact-discovery layer after companies are known; call `ultron_apollo_find_company_contacts` only for requested contact enrichment.
9. Before Google Sheet export call `ultron_google_workspace_status`.
10. If Google auth is unavailable, preserve the mission and lead master, set the next action to Workspace connection, and return a concise auth requirement. Do not claim completion.
11. When connected, call `ultron_google_sheet_from_leads`. Final completion requires a real spreadsheet URL/readback, not merely loading the Google Workspace skill.

The model decides search strategy and adapts when recall is poor. Deterministic tools enforce canonical state, evidence and export contracts.


## Canonical sheet POC layout

For lead exports, use this visible POC structure:
- LINKEDIN LINK = POC 1 profile URL. Do not add a separate POC 1 name/designation column.
- PHONE NUMBER + EMAIL immediately after LINKEDIN LINK belong to POC 1.
- 2ND POC NAME + DESIGNATION is one cell, followed by 2ND POC PHONE and 2ND POC EMAIL.
- 3RD POC NAME + DESIGNATION is one cell, followed by 3RD POC PHONE and 3RD POC EMAIL.
- POC 2 and POC 3 must be searched against the CURRENT company observed on POC 1's LinkedIn profile.
- Preserve POC 1 name/designation internally only for dedupe and enrichment exclusions when observed.
