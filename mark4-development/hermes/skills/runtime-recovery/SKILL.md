---
name: runtime-recovery
description: Diagnose and recover Mark 4 startup, provider, browser, mission and integration failures without corrupting persistent work.
---
# Runtime recovery
Read live health, process ownership, model fabric state, mission state and recent events before changing anything.
Fix root causes rather than masking errors. Never allow the UI to bind a surprise port or report ready through an old gateway.
Preserve sessions, missions, evidence, canonical lead data and artifacts across recovery.
For provider failures, classify authentication, quota, rate-limit, transient and request errors separately. Use configured fallbacks and cooldown only the failing credential or route.
After repair, run the relevant contract tests and one real end-to-end action. Report the exact remaining limitation.
