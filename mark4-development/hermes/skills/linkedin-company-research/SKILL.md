---
name: linkedin-company-research
description: Evidence-first company discovery from LinkedIn hiring data with adaptive search strategy and strict dedupe.
---

# LinkedIn company research
When discovery is scoped to LinkedIn, use authenticated LinkedIn capabilities/browser evidence only for discovery. Apollo is enrichment, not discovery.

1. Read the canonical current master/count before searching.
2. Calculate the true remaining gap.
3. Reuse cached/saved evidence first.
4. Prefer job-first discovery when company keyword search has low recall.
5. Map verified active jobs to unique employers.
6. Verify every hard constraint before accepting a company.
7. Deduplicate by canonical company identity, not job count.
8. If generic queries saturate, adapt title families and specialization terms rather than repeating the same search.
9. Respect account safety, checkpoints, auth walls and rate limits. Never bypass CAPTCHA/checkpoints.
10. Update mission state from authoritative output after each committed batch.

For SAP, useful families can include FICO, MM, SD, ABAP, Basis, HANA, S/4HANA, SuccessFactors and BW when relevant.


## Mark 4 authoritative lead state
The native Mark 4 lead master is the source of truth for company count, dedupe and accepted evidence. Do not infer the current total from conversation memory.

Before fresh discovery:
- call `ultron_lead_master_status` with the mission target;
- search existing leads with `ultron_lead_master_search`;
- calculate the verified remaining gap from the returned registry stats.

When a company passes the user's hard constraints, save it with `ultron_lead_master_upsert`.
For LinkedIn verification, only set `verificationStatus: "verified"` when an active LinkedIn job URL was actually inspected and include `evidence.activeJobVerified: true`. Store useful evidence such as observed company size, job title, location and inspection time.

Use Hermes authenticated browser/tool capabilities to discover and inspect LinkedIn. The old Mark 3 LinkedIn scraper is not a default Mark 4 capability.

After Apollo enrichment, update the same canonical lead record with the selected contact. Never create a duplicate company row merely because another job or contact was found.


## End-to-end lead research and delivery

When the user asks for jobs/leads plus decision-makers plus a spreadsheet, treat the whole request as one mission rather than returning raw search snippets.

- Create or resume a persistent mission when the request spans discovery, verification, enrichment and export.
- Discovery and enrichment are separate phases. First verify job/company evidence and save each accepted company to the canonical lead master.
- The canonical lead can hold three POCs:
  - POC 1 is the already-selected LinkedIn profile. Its visible sheet identity is the LinkedIn URL, with phone/email beside it.
  - POC 2 and POC 3 are searched from POC 1's CURRENT employer, not automatically from the job company.
  - POC 2/3 prioritize Founder/CEO/Director/Owner, then Co-Founder/Recruiting Head/Recruiting Manager/HR Manager/HR Recruiter.
- Use `ultron_apollo_find_company_contacts` only for enrichment when Apollo is allowed and available. Do not use Apollo for company discovery.
- Never fabricate phone or email values. Empty contact fields stay empty.
- A request for a sheet is not complete after search. Export only after the requested research fields have been populated as far as evidence permits.
- For Google Sheets, call `ultron_google_workspace_status` before export. If OAuth is missing, keep all gathered leads and mission progress, mark the mission blocked on Google auth, and explain the one-time connection step. Do not throw away research or pretend the sheet exists.
- Once authenticated, use `ultron_google_sheet_from_leads` so the export comes from the canonical master rather than model-written rows.
- If the user did not explicitly scope discovery to LinkedIn, choose the best evidence source dynamically; if they did scope to LinkedIn, obey the LinkedIn-only rule above.
