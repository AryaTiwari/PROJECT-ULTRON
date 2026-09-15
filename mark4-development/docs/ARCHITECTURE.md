# ULTRON Mark 4 architecture

## Authority

Hermes cognition decides strategy and next actions.

Deterministic code defines capability contracts, approvals, authentication, rate/cost boundaries, persistence, resource limits and evidence truth.

```text
UI / Voice
   |
Mark 4 Gateway
   |---- Mission + Evidence SQLite
   |---- Model Fabric
   |---- Event stream
   |
Hermes API (v2026.9.14)
   |---- sessions / branching / skills / memory
   |---- context compression / tool search / subagents
   |---- browser / terminal / web
   |
Mark 4 MCP Capability Host
   |---- mission state
   |---- evidence
   |---- Elevate business context
   |---- native business capabilities
   |
External systems
```

## Mark 3 quarantine

No Mark 3 subsystem is trusted merely because it exists.

Mark 3 contributes domain rules, schemas, tests, cached evidence and lessons. Execution code is native-first.

Legacy code is disabled unless explicitly allowed through Mark 4 policy and should be promoted only after:
- typed inputs/outputs;
- real evidence production;
- restart safety;
- resource bounds;
- regression coverage;
- no hidden routing authority.

## Mission state

Mission state is separate from conversation compression.

It stores:
- objective;
- hard constraints;
- completion criteria;
- measurable state;
- current strategy;
- concise next action;
- evidence references.

It never stores private chain-of-thought.

## Evidence

Agent text is not proof.

Examples of valid evidence:
- provider receipt or message ID;
- LinkedIn job/company identifier and URL;
- spreadsheet write plus readback;
- Git commit SHA;
- file hash;
- verified contact identity;
- external API record ID.

Mission completion requires completion criteria plus required evidence.

## Model fabric

Models are replaceable processors underneath ULTRON.

Roles:
- cognition;
- worker;
- verifier;
- creative.

Routes are scored using configured priority plus observed success and latency. Paid use is disabled by default. The free-LLM catalog is a discovery source only and never automatically promotes a model into the trusted pool.

## Resource budget

- No local LLM.
- Low process count.
- Hermes and Mark 4 gateway concurrency kept small.
- Operations view uses Canvas 2D and pauses while hidden.
- Browser/media engines should be lazy.
- Reel render queue should remain one.
- SQLite replaces service-heavy Redis/Kafka-style infrastructure.

## UI provenance

- Onyx: visual-system concepts only. Its implementation is Luau/Fusion.
- Agents Kit: interaction reference only because its root license is non-commercial.
- DSH nested followups: interaction concept; implementation uses Hermes native session forking.
- AgentOffice: visual semantics reference only; no Ollama/Colyseus/Redis inheritance.

Palette: near-black, deep navy/blue, white and restrained semantic accents.
