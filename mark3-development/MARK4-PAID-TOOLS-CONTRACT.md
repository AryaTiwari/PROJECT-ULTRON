# ULTRON Mark 4 Paid-Tool Contract

This contract is intentionally portable from Mark 3 into Mark 4.

## Rule

ULTRON must never start a credit-consuming or quota-sensitive external tool run merely because it inferred intent. Explicit user approval is required for that run.

## One-run approval boundary

1. ULTRON understands the requested task.
2. ULTRON completes free/local work first whenever possible.
3. Before a paid/quota-sensitive provider is called, ULTRON creates a pending approval describing the provider and operation.
4. No provider request is made until the user explicitly approves.
5. Approval is scoped to that one pending operation and expires after a short TTL.
6. A new task, retry, resume that can make fresh paid calls, or a different provider requires new approval.
7. Denial cancels the pending paid action without undoing safe work already completed.

## Current guarded providers

- Apollo: office-owned, credit-consuming lead enrichment. Apollo enrichment is hard-guarded at runtime and cannot execute outside an approved permit context.
- TinyFish Search in Lead Research: external search API/quota usage. Lead discovery asks before starting the search run.

## Lead generation sequence

Natural command -> Input Intelligence -> Lead Research Operator -> approval for external search -> public lead discovery -> de-duplication -> Google Sheet append -> free public email/phone recovery -> separate Apollo approval if missing contact enrichment was requested -> local/cache-first Apollo enrichment.

Google Sheets writes themselves are not treated as paid-tool consumption, but the operator must append only intended rows, preserve unrelated columns/data, and avoid overwriting existing contact details.

## Mark 4 integration requirement

Mark 4 may replace the interface, router, models, or operators, but the paid-tool approval gate must remain outside model inference and below task interpretation so no model can bypass it by phrasing a tool call differently.
