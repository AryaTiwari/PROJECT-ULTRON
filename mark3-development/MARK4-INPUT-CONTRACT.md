# ULTRON Mark 4 Input Contract

Mark 3 now exposes a portable input-understanding boundary so Mark 4 can replace the UI, model router, or individual operators without rebuilding command interpretation.

## Stable contract

`core/input-intelligence.js` resolves every assistant-bound command into an envelope with:

- `originalMessage`
- `normalizedMessage`
- `resolvedMessage`
- `intent`
- `confidence`
- `source`
- `vague`
- `autoResolved`
- `clarification`
- `candidate`

Resolution is local and deterministic. It makes zero model/API calls.

## Safety rule

Explicit commands pass through. Vague commands may reuse a high-confidence similar prior command. Ambiguous or risky vague actions are clarified instead of guessed. Destructive/external actions such as sending, publishing, deploying, deleting, buying, transferring, or committing are never silently inherited from a bare `do it`.

## Native input surface

Typed input is no longer conceptually a transcript add-on. `interface/native-command-input.js` moves the composer into the primary ULTRON surface and exposes `data-input-contract="mark4-ready-v1"`. Voice and typed input continue through the same `/api/chat` execution path.

Attachments are first-class controls inside the same command dock. `multimodal-ui.js` binds to the native `#attachButton`, `#fileInput`, and `#attachmentStrip` controls rather than constructing a separate attachment UI.

## Mark 4 migration invariant

Mark 4 should preserve this flow:

`voice/text/file -> input intelligence -> domain operator/router -> execution -> response`

Keep the resolver model-free. Models may reason about the task after intent resolution, but they should not be required merely to understand `same for this`, `run it again`, a bare target, or another short continuation.

## Runtime check

`GET /api/input/status` reports resolver readiness and contract metadata.

Regression check:

```powershell
node scripts\input-intelligence-selftest.js
```
