# ULTRON Mark 2 status telemetry

The status subsystem is intentionally provider-aware and reports real runtime state only.

## UI status keys

- `mood`: current ULTRON runtime mood. Defaults to `CALM` until the mood engine writes `.ultron/mood.json`.
- `github`: `CONNECTED`, `REACHABLE_UNAUTHENTICATED`, or `OFFLINE`. A GitHub token is required for authenticated repository access.
- `instagram`: `CONNECTED`, `NOT_CONFIGURED`, or `AUTH_OR_NETWORK_ERROR`. Requires an Instagram access token; a user ID is optional when the token supports `/me`.
- `administrator`: `ELEVATED`, `STANDARD`, or `UNKNOWN`. This reflects the Windows process token; it does not attempt privilege escalation.
- `omniroute`: `ONLINE`, `ONLINE_AUTH_REQUIRED`, or `OFFLINE`.
- `internetSpeed`: connectivity plus a measured download rate from the configured speed-test endpoint.
- `memory`: local storage readiness and whether Supabase credentials are configured.

## Environment variables

`GITHUB_TOKEN` / `GH_TOKEN` — authenticated GitHub access for ULTRON.

`INSTAGRAM_ACCESS_TOKEN` / `IG_ACCESS_TOKEN` — Instagram Graph API access token.

`INSTAGRAM_USER_ID` / `IG_USER_ID` — optional Instagram account ID.

`SUPABASE_URL` plus `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_ANON_KEY` — persistence configuration.

`OMNIROUTE_BASE_URL` — local OmniRoute URL, normally `http://127.0.0.1:20128`.

`INTERNET_SPEED_TEST_URL` — optional replacement for the default Cloudflare download probe.

## Security

Status endpoints must never return secrets. They return only whether a credential is configured and whether a provider can be reached/authenticated.

GitHub and Instagram actions themselves must remain behind explicit adapters and the existing Guardian/Executor permission layer. A status of `CONNECTED` does not grant a tool permission by itself.
