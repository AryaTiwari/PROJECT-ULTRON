# Project Ultron — Architecture

## Core principle

Ultron is an orchestration system, not a single AI model.

```text
Interfaces
  ├── Laptop microphone / wake word
  ├── Alexa
  ├── Future phone microphone
  └── Future dedicated hardware
             |
             v
        Ultron Core
        ├── Personality
        ├── Memory
        └── Router
             |
             v
            n8n
             |
     +-------+--------+----------------+
     |                |                |
  AI models       APIs / tools     Databases
     |                |                |
 Gemini / free    Weather / stocks  Supabase
 local models     Gmail / Instagram  CRM / memory
                  WhatsApp / etc.
             |
             v
       Response layer
             |
          TTS / UI
```

## Model routing

- Deterministic operations should bypass AI.
- Simple classification/extraction can use a lightweight/free model.
- Gemini or another strong model handles complex reasoning.
- The router must be replaceable so providers can change without redesigning Ultron.

## Memory

Supabase is the persistent source of truth.

Planned layers:

1. Conversation archive — all messages.
2. Long-term memories — durable facts and preferences.
3. Episodic/project memory — useful past events and project context.
4. Semantic memory — embeddings/vector search for retrieving relevant older discussions.

## Tool design

Every external capability should be modular and permission-aware. Examples:

- weather
- stocks
- reminders
- Gmail
- Google Calendar
- GitHub
- web search
- Instagram Business
- Elevate OS
- creator CRM
- WhatsApp
- website/development

New integrations should be addable without changing the personality or memory systems.

## Safety / confirmation

Actions such as sending messages, publishing content, editing production code, or other irreversible operations should initially require confirmation. Trusted automation can be enabled later per tool/action.
