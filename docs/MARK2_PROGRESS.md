# ULTRON Mark 2 Progress

## Implemented

- Local-first ULTRON Core HTTP API
- Editable personality configuration
- Guardian safety layer
- Critic evaluation layer
- Permission-aware Executor registry
- Task classification and model policy
- OmniRoute-compatible OpenAI chat gateway
- Local persistent conversation store
- Supabase memory adapter
- Memory Judge with exact, normalized, lexical near-duplicate checks
- Optional embedding-based semantic duplicate hook
- Supabase schema for conversations, memories, model performance, and system events
- Capability-source boundaries for Brahma, Jarvis/OpenJarvis, and Multi-AI Brain
- One-command local startup helper
- Replaceable interface boundary for the future Google AI Studio UI

## Next implementation queue

1. Memory Judge v2: semantic embeddings, update/supersede logic, stronger entity-aware memory.
2. Tool adapters: computer, PowerShell, files, browser, GitHub.
3. Model performance telemetry and learned routing.
4. Brahma voice/browser capabilities wrapped as ULTRON tools.
5. Wake-word and speech pipeline.
6. GitHub-aware update manager with staged changes and rollback.
7. Self-healing diagnostics.
8. Controlled self-upgrade pipeline.
9. Final Google AI Studio interface integration.

## Safety rule

The Executor never runs an unregistered action. Destructive or external-side-effect actions must carry explicit tool metadata and confirmation policy.
