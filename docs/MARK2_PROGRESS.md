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
- Model performance telemetry with local fallback
- Core inspection endpoint for future UI
- Supabase schema for conversations, memories, model performance, and system events
- Permission-aware laptop tools
- Fish Audio ULTRON voice adapter with the selected reference voice
- TTS tool registration and `/api/tts` endpoint
- Voice status endpoint for the future interface
- Strict ULTRON-only wake-word detector
- Voice state machine: idle/listening/thinking/speaking/error
- Replaceable STT adapter contract
- Voice pipeline contract: wake word -> STT -> Core -> TTS
- Capability-source boundaries for Brahma, Jarvis/OpenJarvis, and Multi-AI Brain
- One-command local startup helper
- Replaceable interface boundary for the future Google AI Studio UI

## Next implementation queue

1. Memory Judge v2: semantic embeddings, update/supersede logic, stronger entity-aware memory.
2. Tool adapters: PowerShell, files, browser, GitHub, controlled computer actions.
3. Learned model routing from performance history.
4. Fish Audio streaming/playback pipeline and voice-state events.
5. Real microphone capture and STT adapter selection.
6. GitHub-aware update manager with staged changes and rollback.
7. Self-healing diagnostics.
8. Controlled self-upgrade pipeline.
9. Final Google AI Studio interface integration.

## Wake-word policy

The activation word is strictly `ULTRON`. The speech recognizer must not require or synthesize prefixes such as "Hey ULTRON" or "Okay ULTRON". Detection is case-insensitive and may accept a spoken command immediately after the word.

## Safety rule

The Executor never runs an unregistered action. Destructive or external-side-effect actions must carry explicit tool metadata and confirmation policy.