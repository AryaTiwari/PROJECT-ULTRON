# ULTRON Mark 2 Test Build

This branch contains the backend test build. The final Google AI Studio interface is intentionally excluded.

## Start

1. Keep OmniRoute running on `127.0.0.1:20128`.
2. Ensure local `.env` contains the OmniRoute and Fish Audio credentials.
3. Run `npm run core:start`.
4. On Windows, start the voice daemon with `npm run core:voice` or `POST /api/voice/daemon/start`.

## Checks

- `npm run core:check`
- `npm run core:memory-test`
- `npm run core:voice-test`
- `npm run core:test-build`
- `npm run core:diagnose`

The real microphone/STT and provider calls depend on the target laptop's hardware, credentials and local services, so those are runtime acceptance checks rather than GitHub-only checks.
