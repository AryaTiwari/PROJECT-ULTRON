# Ultron Desktop Interface

## Goal

Ultron should have a lightweight desktop interface that remains hidden/minimized during normal laptop use and becomes visible when the Ultron wake word is detected.

## Planned states

- **Idle:** UI hidden or reduced to a minimal unobtrusive indicator.
- **Wake detected:** floating popup appears and shows `Listening...`.
- **Thinking:** UI shows that Ultron is processing the request.
- **Speaking:** UI shows that Ultron is responding.
- **Inactive:** after a configurable period without interaction, return to hidden/minimal state.

## Planned interaction

```text
Windows starts
    -> Ultron background service starts
    -> Wake-word detector becomes ready

User says: "Ultron"
    -> Wake word detected
    -> Desktop popup appears
    -> Microphone input is captured
    -> Request is sent to Ultron Core
    -> n8n routes tools/AI calls
    -> Response is returned
    -> TTS speaks response
    -> Popup displays response
```

## Technology direction

The UI should be lightweight and desktop-native. Candidate technologies are Tauri or Electron; choose later based on resource usage and implementation simplicity.

The wake-word listener, UI, audio pipeline, and Ultron Core should remain modular so that the same backend can later be used by a phone, Alexa interface, ESP32 voice terminal, or dedicated hardware.

## Requirements

- Windows-first for Ultron v1.
- Hidden/minimized when idle.
- Wake-word controlled activation.
- Visible listening/thinking/speaking states.
- Automatic startup can be added after the core system is stable.
- A manual detection-stop/shutdown control must always be available.
- UI must not contain API secrets.
- UI should communicate with the local Ultron Core through a controlled local interface rather than directly embedding provider credentials.
