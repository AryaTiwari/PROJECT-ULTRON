# PROJECT ULTRON

Personal AI assistant project — modular, voice-enabled, tool-using, and designed for long-term expansion.

## Mark 2 unified runtime

The `mark2-development` branch is the single development surface for ULTRON Core and the Interface1 UI.

```text
User
  |
  v
Integrated Interface1 UI
  |
  v
ULTRON Mark 2 Core (single 127.0.0.1:8787 service)
  |--- Guardian
  |--- Critic
  |--- Executor
  |--- Memory Judge / Retriever
  |--- OmniRoute model router
  |--- Voice / TTS
  |--- Local credential vault
  |--- Live system status
```

### Start everything

```powershell
git checkout mark2-development
git pull origin mark2-development
npm start
```

Then open:

```text
http://127.0.0.1:8787/
```

`npm start` provisions the UI build dependencies when they are missing, synchronizes the pinned Interface1 source into a local ignored cache, builds the React UI, and starts the ULTRON Core server. You do not need to start the old Interface1 server separately.

The exact Interface1 source revision is pinned in `interface-manifest.json` so the integrated runtime is reproducible.

## Current capabilities

- Long-term local memory with duplicate/semantic judging and retrieval
- Consistent ULTRON personality across model providers
- OmniRoute-compatible model routing
- Guardian → Critic → Executor decision pipeline
- Fish Audio voice integration with the configured ULTRON voice and optional metallic post-processing
- Laptop voice daemon / wake-word groundwork
- Live GitHub, Instagram, administrator, OmniRoute, internet-speed, memory, and mood status checks
- Local credential vault using Windows DPAPI-backed storage
- Integrated Interface1 globe, orbital mesh, chat console, diagnostics, decision history, personality controls, soundscape, and transcript export
- Mood-driven interface palette with CALM blue as the baseline

## Security

Never commit API keys, access tokens, passwords, Supabase service-role keys, or other secrets. Use the local credential vault or environment variables. The generated Interface1 vendor directory is ignored by Git.

## Development philosophy

1. Prefer deterministic APIs/workflows when AI reasoning is unnecessary.
2. Use lightweight/free models for simple tasks.
3. Use stronger models such as Gemini for complex reasoning.
4. Keep memory independent from any single AI provider.
5. Keep integrations modular so new APIs can be added without rebuilding the core.
6. Require confirmation for sensitive or irreversible actions until explicitly trusted.
