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
6. Enrich contacts only after company/job verification. Prefer primary executive and secondary recruiting contact. Never invent missing phone/email.
7. If Apollo is used, call `ultron_apollo_find_company_contacts`; Apollo is enrichment, not discovery.
8. Before Google Sheet export call `ultron_google_workspace_status`.
9. If Google auth is unavailable, preserve the mission and lead master, set the next action to Workspace connection, and return a concise auth requirement. Do not claim completion.
10. When connected, call `ultron_google_sheet_from_leads`. Final completion requires a real spreadsheet URL/readback, not merely loading the Google Workspace skill.

The model decides search strategy and adapts when recall is poor. Deterministic tools enforce canonical state, evidence and export contracts.
