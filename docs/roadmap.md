# Project Ultron Roadmap

## Phase 0 — Foundation

- GitHub repository
- Local development environment
- Docker
- n8n self-hosted locally
- Supabase project
- Environment/secrets management

## Phase 1 — Ultron Core

- Stable Ultron personality
- Request/response router
- Gemini integration
- Provider abstraction so additional AI models can be added
- Supabase-backed conversation and long-term memory
- Tool registry for APIs and automations

## Phase 2 — Personal assistant capabilities

- Reminders
- Email automation
- Weather API
- Stock-market API
- Web/search tools
- Calendar integration
- GitHub/development tools
- Personal task automation

## Phase 3 — Desktop voice assistant

- Windows desktop UI
- Local microphone input
- Wake-word detection
- Speech-to-text
- Text-to-speech
- Popup states: idle, listening, thinking, speaking
- Automatic startup with Windows
- Manual stop/shutdown control

## Phase 4 — External services

- WhatsApp personal automation where permitted by the platform/API
- Instagram personal/business integrations where permitted by Meta APIs
- Elevate OS integrations
- Additional APIs and open-source services

## Phase 5 — Hardware

- Alexa interface
- Optional ESP32-S3 voice terminal
- Optional Raspberry Pi / low-power always-on server
- Shared Ultron Core across laptop, phone and hardware interfaces

## Design rule

Do not hard-code the assistant to one AI provider, one interface, or one automation platform. Ultron Core, memory, tools, voice, and UI must remain modular so components can be replaced or moved later.
