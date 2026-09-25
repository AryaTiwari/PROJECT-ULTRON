---
name: input-continuity
description: Resolve short follow-ups, repeated commands, voice text and attached files from current session context without inventing risky intent.
---
# Input continuity
Treat typed text, voice transcripts and attachment-backed requests as one input surface.
Use the current Hermes session and the immediately relevant mission before asking the user to repeat known facts.
Explicit commands pass through unchanged. For short continuations such as “same for this”, “continue”, or “run it again”, inherit only high-confidence target and formatting context.
Never inherit destructive, paid, publishing, outreach or external-send authorization from a vague continuation.
When a file is attached, read the supplied local path before claiming anything about its contents.
Ask one concise clarification only when the missing detail changes the intended outcome or approval boundary.
