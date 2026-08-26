# PROJECT ULTRON — Mark 2

ULTRON is a local-first personal AI assistant designed as an orchestration system rather than a single model.

## Mark 2 foundation

```text
User / future UI / voice
          |
          v
     Input Normalizer
          |
     +----v-------------------------------+
     |            ULTRON CORE              |
     | Personality / Context / Memory     |
     | Guardian / Critic / Executor       |
     +----+-------------------+------------+
          |                   |
          v                   v
     Model Router          Tool Layer
          |                   |
       OmniRoute        Brahma / Jarvis /
          |             future native tools
          v                   |
     AI providers             |
          |                   |
          +---------+---------+
                    v
              Response layer
                    |
             future UI / voice
```

## Current Mark 2 components

- Editable ULTRON personality configuration in `core/personality/default.json`.
- Flexible Guardian risk gate in `core/guardian.js`.
- Critic approach-analysis layer in `core/critic.js`.
- Permission-aware Executor boundary in `core/executor.js`.
- OpenAI-compatible model gateway adapter in `core/model-router.js`, ready for local OmniRoute.
- Supabase-backed memory adapter plus a local fallback cache.
- Initial Supabase schema in `supabase/migrations/0001_mark2_memory.sql`.
- Local Core HTTP API in `core/server.js`.
- Interface remains replaceable; the current `interface/` folder is only a temporary development client.

## Donor projects

`BRAHMA-BODY`, `JARVIS-BODY`, and `MULTI-AI-BRAIN` are capability sources. We will selectively integrate proven pieces instead of merging their application shells wholesale.

See `integrations/CAPABILITY_SOURCES.md` and `docs/MARK2_ARCHITECTURE.md`.

## Local development

Install Node.js 18+.

Run the core:

```powershell
npm run core:start
```

Check that the core modules load:

```powershell
npm run core:check
```

Health endpoint:

```text
http://127.0.0.1:8787/health
```

For model responses, configure `OMNIROUTE_CHAT_URL` and run the local OmniRoute gateway. If it is unavailable, ULTRON reports the failure instead of returning a fake response.

## Secrets

Never commit real API keys, OAuth tokens, Supabase service-role keys, passwords, or other credentials. Use `.env` locally; `.env.example` contains placeholders only.

## Branching

Mark 2 foundation work is developed on the `mark2-foundation` branch first. The final Google AI Studio interface will be integrated later behind the stable ULTRON Core API contract.
