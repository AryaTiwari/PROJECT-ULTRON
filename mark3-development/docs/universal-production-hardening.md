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
- User-facing results lead with completion state and unresolved rows. The detailed technical formatter remains available as formatDetailedResult.

## Existing architecture retained

The one-run paid approval gate and saved mission re-entry, deterministic bootstrap, Apollo native phone reveal, paid-request reuse, business-email quality checks, LinkedIn limits, shared discovery cache, staged deterministic rechecks, bounded direct AI rescue, provider error vocabulary and circuit breaker remain in place.

## Verification

22 focused regression scripts passed with live fetch disabled and runtime storage redirected to temporary test directories. The new production-safety suite exercises varied layouts, normalization, orphan protection, conflicting live edits, batches, requested third-contact auditing and callback ownership. Existing regression suites cover approval, Apollo retries/rate limits, native phone settlement, AI bounds, provider fault containment and routing.

Run individual tests without loading .env:

    node --require ./mark3-development/scripts/universal-offline-test-bootstrap.js mark3-development/scripts/universal-production-safety-selftest.js

## Operational limits

No live Google Sheets, Apollo, LinkedIn or model calls were made for validation. End-to-end correctness and 10–30-row timing still require a separately approved validation run.

Google Sheets values writes do not offer an atomic compare-and-swap through this adapter. The live checks reduce the race window but cannot prevent an external editor changing a cell between the read and write. Avoid concurrent editing during enrichment.

Counters inherited from the existing pipeline are stage counters: settlement phone/email counts exclude synchronous initial hydration writes, and row counters may include revisits. The concise report labels settlement counts explicitly; a complete unique-row/provider-call accounting redesign is not included here.

This patch is production hardening of the existing engine, not a claim that every item in the supplied 40-section specification has been independently validated against live providers.
