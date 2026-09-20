# Universal enrichment production hardening

This upgrade extends the existing Mark 3 enrichment pipeline. It does not replace ULTRON or modify Mark 4.

## Changes

- Plain Name columns retain verified designations when there is no title column. Existing dash, pipe, comma-title and parenthesized identities share one parser.
- Embedded email addresses normalize deterministically. Ambiguous multiple addresses do not become identity proof.
- Orphan contacts require matching contact evidence in the write planner itself. Phone comparison preserves explicit international digits and does not infer missing country codes from suffixes.
- Primary and AI/fallback writes re-read the live row and header before a batch. Changed identities, company context, headers, occupied destinations or out-of-row coordinates stop that row safely.
- Pending phone/email settlement verifies identity coordinates and headers before writing. Background records also retain company context. Older records without ownership evidence require reinspection; their request IDs are not discarded.
- Failed callback reads no longer turn into assumed blank cells. Pending assignments are saved before polling, and individual ownership failures do not prevent other callbacks from settling.
- Duplicate detection can use normalized names, LinkedIn, email, phone and Apollo identity.
- Ambiguous field alternatives and shared coordinates trigger schema clarification. An untargeted multi-tab workbook cannot silently select the highest-scoring tab.
- Final auditing includes requested POC-3 and missing contact fields, and only requires identity fields actually present in the schema.
- All requested POC slots share one employer-scoped discovery pool, while exact identity hydration remains distinct-person and reusable across rows.
- Per-run accounting reports unique rows and cells changed, verified/repaired/new contacts, phone/email writes, pending callbacks, provider calls and bounded AI calls.
- Pending email and phone ownership survives restart and resumes only after exact sheet, row, group and identity checks.
- User-facing results lead with completion state and unresolved rows. The detailed technical formatter remains available as formatDetailedResult.

## Existing architecture retained

The one-run paid approval gate and saved mission re-entry, deterministic bootstrap, Apollo native phone reveal, paid-request reuse, business-email quality checks, LinkedIn limits, shared discovery cache, staged deterministic rechecks, bounded direct AI rescue, provider error vocabulary and circuit breaker remain in place.

## Verification

24 focused regression scripts passed with live fetch disabled and runtime storage redirected to temporary test directories. The suites exercise varied and unfamiliar layouts, 17 name-header aliases, normalization, orphan protection, conflicting live edits, formula cells, bounded callback concurrency, durable ownership, requested third-contact auditing, approval fingerprints, Apollo retries/rate limits, bounded AI, provider fault containment and routing.

The coordinated end-to-end test runs 30 rows with three contacts per row. It fills 90 distinct contact slots and 270 cells from one shared employer search plus three distinct-person hydrations, batches one write per row, and confirms that a second run makes zero writes.

Run individual tests without loading .env:

    node --require ./mark3-development/scripts/universal-offline-test-bootstrap.js mark3-development/scripts/universal-production-safety-selftest.js

## Operational limits

No live Google Sheets, Apollo, LinkedIn or model calls were made for validation. End-to-end correctness and 10–30-row timing still require a separately approved validation run.

Google Sheets values writes do not offer an atomic compare-and-swap through this adapter. The live checks reduce the race window but cannot prevent an external editor changing a cell between the read and write. Avoid concurrent editing during enrichment.

The implementation covers the requested deterministic schema mapping, all-POC coordination, paid approval continuity, identity-safe writes, credit reuse, durable asynchronous contacts, bounded model use, provider-aware completion states, run metrics and plain-English error reporting. Live provider behavior still depends on the connected accounts, quotas and current external APIs, so the offline verification is not a substitute for a separately approved live enrichment run.
