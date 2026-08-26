# ULTRON Core — Mark 2

This directory is the local assistant core. The future interface is deliberately decoupled from it.

## Start locally

```powershell
npm run core:start
```

Health check:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
```

Chat test:

```powershell
$body = @{ message = 'Hello ULTRON' } | ConvertTo-Json
Invoke-RestMethod http://127.0.0.1:8787/api/chat -Method POST -ContentType 'application/json' -Body $body
```

The core expects a local OpenAI-compatible gateway through `OMNIROUTE_CHAT_URL`. OmniRoute itself is an optional dependency at runtime: if it is not running yet, the core will report the gateway failure instead of falling back to a fake response.

## Modules

- `ultron-core.js` — orchestration and context boundary
- `personality/default.json` — initial editable personality
- `guardian.js` — flexible safety/risk gate
- `critic.js` — approach/side-effect analysis
- `executor.js` — registered tool execution boundary
- `model-router.js` — OpenAI-compatible local gateway adapter
- `memory.js` — provider-independent memory normalization and duplicate checks
- `server.js` — localhost API

## Important

Do not put API keys into this repository. Keep secrets in `.env` locally.
