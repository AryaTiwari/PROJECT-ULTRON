# ULTRON MARK 2 — Architecture Foundation

## Purpose

Project ULTRON is the canonical application. Brahma Body, Jarvis Body, and OmniRoute are treated as capability sources, not as competing application roots.

The Mark 2 design keeps the interface replaceable while the local assistant core remains stable.

## Layered architecture

```text
                         USER
                           |
                 Interface / Voice Layer
                  (replaceable, future UI)
                           |
                    Input Normalizer
                           |
                +----------v-----------+
                |     ULTRON CORE      |
                |----------------------|
                | Personality          |
                | Context Builder      |
                | Memory Manager       |
                | Task Classifier      |
                | Model Router         |
                | Guardian              |
                | Critic                |
                | Executor             |
                +----------+-----------+
                           |
             +-------------+-------------+
             |             |             |
          AI Brain      Tools         Memory
        OmniRoute /    Brahma /       Supabase /
        future models  Jarvis /       local cache
                       native tools
                           |
                     Response Pipeline
                           |
                    Text / Voice / UI
```

## Non-negotiable design rules

1. `PROJECT-ULTRON` is the source of truth for the application.
2. No provider-specific AI SDK should own personality or memory.
3. The future Google AI Studio interface must communicate with the core through a stable API boundary.
4. Memory must remain provider-independent.
5. Routing decisions must be observable and auditable.
6. Guardian, Critic, and Executor are separate responsibilities.
7. High-risk or irreversible actions require an explicit permission policy.
8. Self-upgrade mechanisms must stage changes, validate them, and support rollback. They must not blindly overwrite the running system.
9. Missing or unhealthy model providers are marked unavailable rather than crashing the whole assistant.
10. Secrets stay in environment variables and are never written to source files.

## Decision pipeline

```text
INPUT
  -> normalize
  -> load relevant memory
  -> classify task
  -> Guardian pre-check
  -> Critic analysis
  -> route to best available model/tool
  -> Executor performs permitted action
  -> validate result
  -> generate response
  -> record conversation + outcome
  -> optionally update model/tool performance metrics
```

### Guardian

The Guardian is a safety and permission gate. It should normally warn and propose a safer route rather than simply refusing. It can block clearly dangerous, destructive, unauthorized, or security-sensitive actions.

### Critic

The Critic evaluates the proposed approach before execution. It checks assumptions, feasibility, side effects, security, and whether a better route exists.

### Executor

The Executor is the only layer allowed to perform registered actions. Tools should expose explicit permission metadata so the Executor can decide whether confirmation is required.

## Model routing

The router should eventually maintain a provider registry containing:

- provider
- model ID
- capabilities
- availability
- context limit
- rate limits
- estimated cost
- latency history
- task-quality score
- failure count
- last successful call

Routing should prefer the best currently available model for the task, then fall back when a provider is unavailable or exhausted.

## Memory

Memory is divided conceptually into:

- conversation history
- durable facts
- preferences
- projects
- tool/model performance
- system events
- learned operational knowledge

A memory candidate must pass relevance and duplicate checks before being stored as durable memory.

## Self-healing / upgrades

Future self-maintenance follows:

```text
Detect -> Diagnose -> Propose -> Backup -> Apply in isolated/staged state
-> Test -> Promote OR Rollback
```

The assistant may automatically repair low-risk recoverable failures, but upgrades that modify permissions, credentials, security controls, or core execution must use explicit policy/approval.

## Interface boundary

The current `interface/` directory is retained as a temporary development interface. The final Google AI Studio interface will be able to replace it without changing the core contracts.
