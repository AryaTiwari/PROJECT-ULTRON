# ULTRON Mark 4

ULTRON Mark 4 is a Hermes-powered cognitive operating layer, not a renamed Mark 3 router.

## Current architecture

- Hermes Agent pinned to stable release `v2026.9.14`.
- Native Mark 4 gateway with persistent SQLite mission/evidence state.
- Real Hermes sessions, session forking and streaming tool progress.
- MCP capability host for ULTRON mission state, evidence, Elevate context and native business capabilities.
- Role-aware model fabric with observed success/latency scoring and Hermes default fallback.
- Mark 3 quarantine. Legacy execution is denied unless explicitly enabled.
- React/Vite cockpit in restrained black, navy, blue and white.
- Command, Mission, Branches and Operations views.
- Operations view is event-driven and lightweight: Canvas 2D around 30 FPS, no game engine, no local LLM.
- Browser voice input uses the browser speech-recognition surface when available.
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

Provider credentials remain outside Git. Hermes can use supported provider credentials inherited from your environment or its own setup flow.

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

Mark 4 intentionally does not auto-import the old LinkedIn scraper or Reel engine.

Mark 3 contributes:
- domain rules;
- schemas;
- successful strategies;
- regression cases;
- authentication knowledge;
- verified cached evidence.

Execution code is native-first. A legacy adapter must be explicitly enabled and must pass Mark 4 capability contracts before use.
