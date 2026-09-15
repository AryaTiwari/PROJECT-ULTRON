# Mark 4 Native Reel Engine

The Reel engine is intentionally mechanical. Hermes/ULTRON owns creative strategy; this service turns an explicit storyboard into a deterministic vertical video.

## Pipeline
```
creative objective
  -> Hermes script/storyboard
  -> ReelRecipe
  -> branded SVG scenes
  -> Sharp PNG rasterization
  -> FFmpeg motion clips
  -> xfade composition
  -> ffprobe verification
```

## Resource contract
- 1080x1920, 30fps.
- Maximum 12 scenes.
- One renderer at a time.
- No local LLM.
- No Chromium/headless browser.
- No paid renderer.
- Intermediate files live under `.ultron/reels/<job-id>`.
- Rendering requires local free FFmpeg/ffprobe; bootstrap does not download opaque binaries.

## Design system
Near-black backgrounds, deep navy surfaces, restrained blue accents, white primary type. Visual hierarchy beats decoration. Scene types cover hooks, metrics, retention graphs, pillar cards, quotes, character beats and CTA frames.

The old Mark 3 Reel factory is not called by this engine.
