# PROJECT ULTRON

Personal AI assistant project — modular, voice-enabled, tool-using, and designed for long-term expansion.

## Vision

Ultron is designed as a personal AI orchestration system rather than a single AI model. Different models and APIs can provide specialized capabilities while a shared personality, memory, and tool layer keeps the experience consistent.

## Initial Architecture

```text
User / Voice Interface
        |
        v
   Ultron Core
   - Personality
   - Memory
   - Router
        |
        v
       n8n
        |
   +----+-----+----------------+
   |          |                |
 Gemini    Other AI Models   APIs/Tools
   |          |                |
   +----------+----------------+
              |
              v
        Response / TTS
              |
        Alexa / Laptop / Phone
```

## Planned Capabilities

- Long-term conversation and personal memory
- Consistent Ultron personality across multiple AI providers
- AI/model routing based on task complexity
- Weather and stock APIs
- Reminders and task management
- Gmail and Google services
- Instagram Business integration
- Elevate OS creator research and CRM workflows
- Website/development assistance
- Personal WhatsApp automation (subject to technical/API constraints)
- Alexa as an interface and speaker
- Laptop wake-word and microphone interface
- Future phone microphone and dedicated hardware interface

## Repository Structure

```text
core/           Ultron identity, memory, routing, prompts
integrations/   External services and APIs
voice/          Wake word, speech-to-text, text-to-speech
tools/          Reusable Ultron tools
n8n/            n8n workflows and documentation
docs/           Architecture and development documentation
```

## Security

Never commit API keys, access tokens, passwords, Supabase service-role keys, or other secrets. Use local environment variables and keep `.env` files ignored by Git.

## Development Philosophy

1. Prefer deterministic APIs/workflows when AI reasoning is unnecessary.
2. Use lightweight/free models for simple tasks.
3. Use stronger models such as Gemini for complex reasoning.
4. Keep memory independent from any single AI provider.
5. Keep integrations modular so new APIs can be added without rebuilding the core.
6. Require confirmation for sensitive or irreversible actions until explicitly trusted.
