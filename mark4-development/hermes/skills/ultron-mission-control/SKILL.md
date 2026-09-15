---
name: ultron-mission-control
description: Persist and drive multi-step ULTRON objectives with explicit completion criteria and evidence.
---

# Mission control
Use `ultron_mission_create` when an objective spans multiple tools, must survive restarts, has a numerical target, or has external side effects.
Maintain objective, hard constraints, measurable current state, completion criteria, current strategy and concise next action.
After meaningful progress, call `ultron_mission_update`.
When an external system supplies verifiable proof, call `ultron_record_evidence`.
A mission is complete only when its completion criteria are actually satisfied. Never store private chain-of-thought.
