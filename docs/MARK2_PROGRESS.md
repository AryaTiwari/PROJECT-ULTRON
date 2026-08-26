# ULTRON Mark 2 Progress

## Test-build backend implemented

- Local-first ULTRON Core HTTP API
- Editable personality configuration
- Guardian / Critic / Executor safety pipeline
- Task classification and explicit model policy
- Learned model selection after configurable evidence threshold
- Authenticated OmniRoute OpenAI-compatible gateway
- Local persistent conversations and Supabase memory adapter
- Memory Judge: exact, normalized, lexical near-duplicate and optional embedding hook
- Relevance-based memory retrieval
- Memory conflict/supersession policy foundation
- Model-performance telemetry and ranking
- Core inspection and maintenance APIs
- Safe self-healing diagnostics and runtime repair
- Controlled self-upgrade validation with rollback branch creation
- Permission-aware system/file/browser/PowerShell tools
- Fish Audio ULTRON voice adapter using the selected reference voice
- TTS endpoint and `speak_text` tool
- Strict `ULTRON` wake-word detector
- Native Windows microphone speech listener and voice daemon
- Voice pipeline: wake word -> transcript -> Guardian/Critic -> Core -> Fish TTS -> Windows playback
- Voice state machine and daemon status API
- Test-build acceptance checks
- Capability-source boundaries for Brahma, Jarvis/OpenJarvis, and Multi-AI Brain
- Replaceable final Google AI Studio interface boundary

## Deliberately left for the final UI phase

- Final Marvel-style ULTRON visual interface
- Mood/visual state animations
- Conversation HUD and system-network visualization
- UI microphone controls and audio waveform presentation

## Runtime verification still required on Arya's laptop

The repository contains the complete backend path, but live microphone hardware, Fish API credentials, OmniRoute credentials, Windows speech recognition availability, and actual local model responses can only be verified on the target laptop.

## Wake-word policy

The activation word is strictly `ULTRON`. The recognizer does not require prefixes such as "Hey ULTRON" or "Okay ULTRON". Detection is case-insensitive and a spoken command may follow the word immediately.

## Safety rule

The Executor never runs an unregistered action. Destructive or external-side-effect actions require explicit tool metadata and confirmation policy. Self-upgrade remains controlled and rollback-aware rather than silently modifying the repository.