# ULTRON Mark 2 — Capability Sources

## Canonical application

`PROJECT-ULTRON` remains the only final application repository.

## BRAHMA-BODY

Source of reusable local-assistant capabilities.

Observed useful areas:

- Windows-first assistant execution
- microphone/live voice foundations
- browser automation bridge
- application/system actions
- filesystem/desktop controls
- existing memory/action architecture ideas

The original project is Electron-based, so its Electron shell is intentionally **not** adopted as the final ULTRON interface.

## JARVIS-BODY / OpenJarvis

This repository contains the OpenJarvis project metadata and dependency specification, including the documented local-first engine/agent/memory/learning architecture. The current copied repository snapshot does not contain the full `src/openjarvis` implementation, so Mark 2 will not make runtime imports from it until the full implementation is available.

Useful architectural ideas to preserve:

- local-first inference
- interchangeable engines
- agents and skills
- trace-based learning
- hardware-aware model selection
- memory/retrieval primitives
- optional server/desktop/speech integrations

## MULTI-AI-BRAIN

This repository is the user's copy of OmniRoute.

Use it for:

- unified provider gateway
- OpenAI-compatible local endpoint
- provider registry
- free/no-auth provider catalog
- routing/fallback/health mechanisms
- model/provider telemetry

Do not make ULTRON depend on every OmniRoute UI or Electron feature. Prefer its backend/provider capabilities behind the ULTRON model-router contract.

## Future integration order

1. ULTRON Core contracts
2. Model gateway
3. Memory + Supabase
4. Brahma/Jarvis execution adapters
5. Voice/wake-word
6. Guardian/Critic/Executor tool permissions
7. Learning/model performance
8. Self-healing and staged self-upgrades
9. Final Google AI Studio interface
