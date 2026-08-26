# ULTRON Mark 2 — Phase 1 Local Setup

Phase 1 goal: prove the local assistant path works before adding voice, computer control, advanced memory, or the final UI.

```text
Client / future UI
       |
       v
http://127.0.0.1:8787/api/chat
       |
   ULTRON Core
       |
 Guardian -> Critic -> Model Router
       |
       v
OmniRoute: http://127.0.0.1:20128/v1/chat/completions
```

## 1. Requirements

- Windows 10/11
- Node.js 18 or newer
- A running OmniRoute instance on `127.0.0.1:20128`
- At least one usable model/provider configured in OmniRoute

## 2. Configure ULTRON

Copy `.env.example` to `.env` and set the values for your local setup.

Important variables:

```text
ULTRON_CORE_HOST=127.0.0.1
ULTRON_CORE_PORT=8787
ULTRON_UI_ORIGIN=http://localhost:3000
OMNIROUTE_CHAT_URL=http://127.0.0.1:20128/v1/chat/completions
ULTRON_MODEL=auto
ULTRON_MODEL_TIMEOUT_MS=120000
```

Supabase variables can remain empty until the memory migration is deployed.

## 3. Run the structural smoke test

From the repository root:

```powershell
npm run core:check
```

This does not call an AI provider. It verifies that the Mark 2 core modules load and the contracts are internally consistent.

## 4. Start the local ULTRON Core

```powershell
npm run core:start
```

Expected log:

```text
ULTRON Core listening at http://127.0.0.1:8787
Model gateway: http://127.0.0.1:20128/v1/chat/completions
```

## 5. Health check

In another PowerShell window:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
```

## 6. Send a real ULTRON message

```powershell
$body = @{ message = "Hello ULTRON. Reply with exactly: MARK2 ONLINE" } | ConvertTo-Json
Invoke-RestMethod `
  -Uri "http://127.0.0.1:8787/api/chat" `
  -Method POST `
  -ContentType "application/json" `
  -Body $body
```

The returned JSON should contain:

- `ok: true`
- `response`
- `model`
- `guardian`
- `critic`

## 7. If the model gateway is unavailable

ULTRON should return a clear error explaining that the model gateway could not be reached. It must not fabricate a response.

## 8. Supabase

The SQL migration is in:

`supabase/migrations/0001_mark2_memory.sql`

Run it in the ULTRON Supabase project when you are ready to activate persistent memory. Phase 1 does not require a Supabase connection for the core health check.
