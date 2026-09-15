---
name: elevate-reel-production
description: Plan and produce lightweight high-retention Elevate OS Reels using evidence, reusable visual systems and outcome learning.
---

# Elevate Reel production
Treat the Reel pipeline as composable stages:
research -> hook/script -> storyboard -> assets -> scene render -> compose -> inspect -> revise -> publish-ready output.

Prioritize immediate hook clarity, strong first seconds, readable mobile typography, Reels-native pacing, retention-aware scene changes, visual hierarchy, appropriate CTA, 9:16 output and safe areas.
Prefer lightweight SVG/canvas/FFmpeg-style rendering and reusable characters/motion systems over heavyweight local generative models.
If asset discovery fails, change visual strategy rather than stalling. Motion graphics, data visualization and the Elevate character universe are valid fallbacks.
Use real performance outcomes and explicit user feedback to improve future recipes.


## Native Mark 4 renderer
Use the Mark 4 native Reel tools instead of legacy Mark 3 Reel modules:
1. Decide the creative strategy and script.
2. Build a compact storyboard using 1-12 scenes.
3. Call `ultron_reel_create_job`.
4. Review the recipe/job if needed.
5. Call `ultron_reel_render_job`.
6. Call `ultron_reel_inspect_job` and verify 1080x1920 output before claiming render completion.

Useful scene types: `hook`, `metric`, `retention`, `pillars`, `quote`, `split`, `character`, `cta`.
The renderer owns only visual mechanics. You own the creative decisions dynamically. Do not invent a giant hidden pipeline.
Rendering is queue=1 by design for Arya's 8 GB machine.
