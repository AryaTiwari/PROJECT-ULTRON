# ULTRON Voice

ULTRON's Mark 2 voice layer uses Fish Audio as the default cloud TTS provider.

## Configured voice

- Provider: Fish Audio
- Model: `s2.1-pro-free`
- Reference ID: `a0739d5765be4143a15dc37f91f19163`

The reference ID is stored in `.env.example` as a non-secret configuration value. The Fish Audio API key must stay local in `.env` under `FISH_API_KEY` and must never be committed.

## Architecture

```text
ULTRON Core
   |
   v
Voice service
   |
   +--> Fish Audio TTS
   |
   v
Audio file / future streaming sink
```

The voice provider is intentionally replaceable. Future local TTS or another cloud provider can implement the same `speak()` contract without changing personality, memory, routing, or UI code.

## Runtime

Fish Audio's current developer API supports `POST https://api.fish.audio/v1/tts` with a bearer key, `reference_id`, and the `s2.1-pro-free` model. Streaming/WebSocket support can be added later for lower perceived latency.
