# ULTRON Mark 2 Progress

## Implemented

- Local-first ULTRON Core HTTP API
- Editable personality configuration
- Guardian safety layer
- Critic evaluation layer
- Permission-aware Executor registry
- Task classification and model policy
- OmniRoute-compatible authenticated OpenAI chat gateway
- Local persistent conversation store
- Supabase memory adapter
- Memory Judge with exact, normalized, lexical near-duplicate checks
- Optional embedding-based semantic duplicate hook
- Relevance-based memory retrieval
- Memory conflict detection and confidence-aware supersession
- Model performance telemetry with local fallback
- Evidence-based learned model selection after a minimum sample threshold
- Core inspection, model-choice, and maintenance-plan endpoints for the future UI
- Controlled self-maintenance plan-only layer with filesystem allowlist
- Permission-aware built-in laptop inspection/browser tools
- Supabase schema for conversations, memories, model performance, and system events
- Capability-source boundaries for Brahma, Jarvis/OpenJarvis, and Multi-AI Brain
- One-command local startup helper
- Replaceable interface boundary for the future Google AI Studio UI

## Next implementation queue

1. Semantic embeddings wired to the selected model provider.
2. Computer/browser/file/PowerShell tool adapters with Guardian policies.
3. GitHub-aware staged update manager and rollback snapshots.
4. Self-healing diagnostics and safe recovery actions.
5. Wake-word, STT, TTS, and voice-state pipeline.
6. Controlled self-upgrade with tests, branch isolation, and rollback.
7. Learned model routing with quality feedback from Arya and tool outcomes.
8. Brahma/Jarvis/Multi-AI Brain capabilities wrapped as ULTRON tools.
9. Final Google AI Studio interface integration.

## Safety rule

The Executor never runs an unregistered action. Destructive or external-side-effect actions must carry explicit tool metadata and confirmation policy. Self-maintenance is plan-only until a later gated upgrade manager is implemented.
