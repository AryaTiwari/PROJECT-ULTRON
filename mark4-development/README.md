# ULTRON Mark 4

ULTRON Mark 4 is a Hermes-powered cognitive operating layer, not a renamed Mark 3 router.

## Current architecture

- Hermes Agent pinned to stable release `v2026.9.14`.
- Native Mark 4 gateway with persistent SQLite mission/evidence state.
- Real Hermes sessions, session forking and streaming tool progress.
- MCP capability host for ULTRON mission state, evidence, Elevate context and native business capabilities.
- Role-aware model fabric with observed success/latency scoring.
- Conversation routing prefers the configured Gemini, Grok xAI and NVIDIA credentials first, followed by existing Groq compatibility credentials, with keyless OpenCode Big Pickle as the final fallback.
- Mark 3 quarantine. Legacy execution is denied unless explicitly enabled.
- React/Vite cockpit in restrained black, navy, blue and white.
- Command, Mission, Branches and Operations views.
- Operations view is event-driven and lightweight: Canvas 2D around 30 FPS, no game engine, no local LLM.
- Browser voice input uses the browser speech-recognition surface when available.
- Local attachment upload with preview and a 10 MB safety bound.
- Durable mission detail covering objective, strategy, constraints, blockers, next action, approvals, evidence, timeline, related sessions and child branches.
- Persistent branches with rename, parent return, anchored context and parent/child comparison.
- Searchable session drawer and a real `Ctrl+K` command palette.
- Native ports of the proven Mark 3 research, lead, Apollo, Sheets, creator, media, artifact, outreach, memory, recovery and coding contracts.
- Free-model catalog snapshot command for `open-free-llm-api/awesome-freellm-apis`.

## Install on Windows

```cmd
cd /d C:\Users\aryat\Project-Ultron
git fetch origin
git checkout mark4-development
git pull --ff-only origin mark4-development
cd mark4-development
npm run bootstrap
```

Bootstrap:
1. checks Node/Python/Git;
2. installs `uv` if needed;
3. clones the pinned Hermes release into ignored `.runtime/vendor/hermes-agent`;
4. runs `uv sync`;
5. creates an isolated Hermes home;
6. copies ULTRON identity and skills;
7. configures the native Mark 4 MCP server;
8. generates local API keys in ignored runtime state;
9. installs the small Mark 4 npm workspace.

Provider credentials remain outside Git. For normal conversation, Mark 4 accepts `GEMINI_APY_KEY` (intentional compatibility alias), `GEMINI_API_KEY`, `GEMINI_API_KEY2`, `GROK_API_KEY`, `GROK_API_KEY2`, `GROQ_API_KEY`, `GROQ_API_KEY2` and `NVIDIA_API_KEY`. Gemini keys are promoted into Hermes' native credential pool. Grok routes to xAI, while Groq remains a separate compatibility provider. Direct routes are tried before keyless `opencode-free/big-pickle`. OmniRoute is retained only for its explicit isolated test command.

## Verify

```cmd
npm run check
npm run catalog:sync
```

## Start

```cmd
npm run dev
```

- UI: `http://127.0.0.1:5174`
- Mark 4 gateway: `http://127.0.0.1:8787`
- Hermes API: `http://127.0.0.1:8642`

## Mark 3 migration rule

Mark 4 intentionally does not auto-import the old LinkedIn scraper or Reel engine. The complete audited mapping is in [`docs/MARK3-CAPABILITY-MIGRATION.md`](docs/MARK3-CAPABILITY-MIGRATION.md).

Mark 3 contributes:
- domain rules;
- schemas;
- successful strategies;
- regression cases;
- authentication knowledge;
- verified cached evidence.

Execution code is native-first. A legacy adapter must be explicitly enabled and must pass Mark 4 capability contracts before use.
