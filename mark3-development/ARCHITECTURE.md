# ULTRON Mark 3 — Architecture Contract

## Runtime layers
1. Input/interaction layer
2. Context engine
3. Working memory
4. Long-term semantic memory
5. Episodic event memory
6. Commitments and goals
7. Planner
8. Tool executor
9. Verification/recovery
10. Model intelligence and routing
11. Voice orchestration
12. Proactive event loop
13. Telemetry
14. Interface projection

## Assistant loop
Observe -> understand -> retrieve context -> plan -> execute -> verify -> learn -> communicate -> persist state.

## Invariants
- no successful operation is reported before verification when verification is possible
- no model capability is claimed without catalog evidence
- no memory is written without duplicate/semantic review
- no proactive interrupt is emitted without attention policy
- no voice utterance overlaps another
- UI lifecycle is derived from runtime events
- failures surface as explicit errors with recovery state
