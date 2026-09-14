# LinkedIn command ownership

## Failure analysis (base commit 75f94cd)

The old HTTP reservation was not exclusive dispatch. It called the current,
mutable `assistant.handle` and checked the returned model/provider only *after*
execution. `linkedin-route-guard.install()` did the same. A successful response
check could not prove that no model had already run.

The browser's `interface/chat-transport.js` independently interpreted artifact
intent: the presence of `report` could prepend `create`. It preserved
`originalMessage`, but `server.js` routed `message`, ignoring that original.
The artifact exception in `linkedin-route-guard.js` also allowed generic
`create/make ... report/document/brief/proposal` phrases without a file format.
These are source-proven escape paths; no saved trace of the user's historical
Nemotron invocation is available in this checkout.

Artifact bypass:

1. `interface/app.js` posts the command; native voice can reconcile transcripts;
   multimodal UI adds attachments; chat transport could rewrite artifact intent.
2. `server.js` parses `/api/chat`. A command excluded by the reservation continues
   through operating-mode commands, self-repository handling and attachments.
3. `multimodal.generationIntent` sees a creation verb and `report`, selects DOCX.
4. `generate` -> `generateDocument` -> document content composition ->
   `integrations.chat(..., auto/best-reasoning, ..., taskType: planning)`.
5. `model-router.chat` tries direct candidates, including the configured NVIDIA
   planning candidate. `direct-provider-router.chat` invokes NVIDIA/Nemotron.
6. Local document rendering creates the artifact. Neither assistant wrapper is
   involved in this path.

Wrapper escape:

`server.js` reservation -> mutable `assistant.handle` -> installed wrapper chain
-> general assistant/model loop when an operation is not handled ->
`integrations.chat` / streaming -> model router -> direct providers or the lazy
OmniRoute fallback. A post-response guard blocks delivery, not provider execution.

`core/forge/preload.js` installs Activity/Context Fabric, Turbo, Operator, Forge,
Adaptive Intelligence, enrichment wrappers, Input Intelligence, Lead Workspace,
LinkedIn and Reel attachment handling in a `setImmediate` callback. Wrappers
capture previous handlers; Input Intelligence can resolve prior conversation
intent. The base assistant independently handles research, chooses a model and
runs its model/tool loop. Model League is optional and normally passive; it is
not needed for the artifact bypass. `direct-model-router.js` is a separate legacy
provider entry point. OmniRoute lazy hooks invoke `omniroute-fallback.ensure`
before the shared transport. All these provider entries need pre-call protection.

The old `linkedin-http-route-selftest.js` searched server source text and tested
predicates. It did not construct an HTTP request, invoke the server, or count
provider/artifact calls.

## Current hierarchy

`POST /api/chat` -> authoritative original message -> basic wake normalization
-> `command-control-plane.dispatch` -> `linkedin-domain-controller.handle`
-> extracted account handler -> deterministic compiler / optional typed Gemini
compiler -> persistent mission runner -> authenticated MCP/cache/verification
-> canonical master output.

An exclusive command returns at this boundary. No attachment inference, operating
mode, self-repository, Input Intelligence, generic assistant, Forge, Turbo,
multimodal composer or general provider runs. Explicit creation of a concrete PDF,
DOCX, Word document, image, video or spreadsheet export remains a separate route.
Reporting mission statistics alone is operational.

The controller initializes synchronously before `server.listen`; it does not need
an installed assistant wrapper. The old bootstrap adapter remains for non-HTTP
and implicit workspace follow-ups. `linkedin-route-guard.js` is now only a
compatibility facade; it installs no wrapper or response blocker.

AsyncLocalStorage carries exclusive ownership into asynchronous domain work.
Background mission execution establishes its own exclusive scope, including jobs
recovered after restart. Model-router and integrations entry points, both direct
provider routers, OmniRoute startup, generic research and artifact generation
assert authority before doing work. The bounded typed compiler has a narrowly
scoped Gemini-only exception. General model entry points also reject explicit
operational user messages without a scope. Violations throw
`LINKEDIN_ROUTE_INVARIANT_VIOLATION`; a caught violation still fails the HTTP
operation. Nemotron remains available for unrelated work.

`command_route_decision` is emitted for each chat dispatch. Set
`ULTRON_M3_ROUTE_DEBUG=1` for credential-free console traces. LinkedIn responses
carry `routing`, `route`, `model`, `provider`, and `taskType`.

## Cache and safety

Existing policy, rolling accounting, manual locks, cooldown scheduling, TTLs,
mission storage, verification and exact eight-column Final Master are retained.
Candidates with cached details are verified before candidates needing live calls.
`toolCalls.callsPerVerifiedCompany` reports fresh budget cost per accepted company
(null when none pass). Explicit saved-mission resume records `savedDiscoveryOnly`:
it replays discovery once, never silently turns a missing cache into a new search,
and keeps details/profile verification under normal safety accounting.

## Verification and limits

`npm run check:linkedin-route` starts the actual `server.js`, sends the historical
class of request via HTTP, and uses the real controller/resume/runner/cache code.
Only costly acquisition/output and unrelated side effects are replaced. It proves
first-request ownership without preload, original-message recovery from a legacy
client, cached progress then `waiting_safety`, zero forbidden calls, and an actual
HTTP PDF exception. Invariants are separately tested against general routing,
NVIDIA and OmniRoute. Test persistence uses a temporary directory.

The test is part of `check:linkedin-account`, `check:linkedin`, `check` and `start`.
Existing cache-only verification separately exercises verified-company production.
A normal preloaded server was also started and received real HTTP status/resume
requests without replacement handlers: both selected the LinkedIn controller;
resume correctly reported that the laptop's mission was unavailable here and
created no artifact. The authenticated Windows browser, actual saved mission and
Google Sheet cannot be live-verified in this checkout. No claim is made that the
user's master has reached 30 companies.
