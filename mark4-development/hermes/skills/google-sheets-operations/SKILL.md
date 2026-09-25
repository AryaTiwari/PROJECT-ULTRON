---
name: google-sheets-operations
description: Create, inspect and fill Google Sheets from canonical Mark 4 state while preserving headings, unrelated data and readback evidence.
---
# Google Sheets operations
Inspect the destination spreadsheet and exact worksheet before planning writes. Resolve worksheet identity by gid and title; never silently choose a different tab.
Map known headings semantically and preserve their visible spelling and order. Ignore contact columns during discovery unless enrichment was explicitly requested.
When an unfamiliar heading can be inferred safely from supplied evidence, fill it; otherwise ask one concise mapping question and persist the answer for the mission.
Write in bounded batches, preserve existing non-empty cells, and checkpoint row ranges. Read back every committed batch.
A Sheet task is complete only with the real spreadsheet URL, worksheet, written range and readback count.
Use `ultron_google_workspace_status` before export and `ultron_google_sheet_from_leads` for canonical lead delivery.
