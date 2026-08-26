# ULTRON Mark 2 — Next Build Sequence

The development branch currently contains the Core, memory decision/retrieval, model gateway, telemetry, and first permission-aware local tools.

## Next build sequence

### 1. Memory intelligence
- Add optional embedding provider abstraction.
- Add entity-aware memory updates.
- When a new fact conflicts with an older fact, supersede the old memory instead of creating two active memories.
- Add explicit `SAVE`, `UPDATE`, `IGNORE`, and `REVIEW` outcomes.

### 2. Model intelligence
- Aggregate model-performance telemetry by task type.
- Score success rate, latency, and quality feedback.
- Use the historical score as a routing signal without overriding explicit model choices.
- Detect failing providers and temporarily sideline them.

### 3. Laptop capabilities
- File read/write tool with path restrictions.
- PowerShell tool behind Guardian + explicit confirmation for commands with side effects.
- Process/application tool.
- Browser automation adapter.
- GitHub adapter.

### 4. Voice
- STT adapter interface.
- TTS adapter interface.
- Wake-word adapter interface.
- UI-neutral voice state events.

### 5. Self-maintenance
- Health registry.
- Dependency/provider health checks.
- Diagnosis records.
- Staged patch/update manager.
- Backup + test + promote/rollback workflow.

### 6. Final interface
- Replace temporary interface with the Google AI Studio UI.
- Keep all Core contracts stable.
