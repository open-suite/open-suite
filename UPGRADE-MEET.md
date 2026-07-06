# Upgrade Meet: virtual-background / blur quality

Status: spec. Tracking: ticket 13. Owner: agent-driven, human final gate on visual quality.

## Problem

La Suite Meet's background blur and virtual backgrounds look markedly worse
than Google Meet / Zoom: a haze halo around the person, and foreground/background
confusion at the edges (hair, shoulders, spectacles). This is a rendering-quality
problem, not a model-availability problem.

## What ships today (v1.20.0)

Meet has two code paths, both in
`src/frontend/src/features/rooms/livekit/components/blur/`:

- Primary — `UnifiedBackgroundTrackProcessor.ts` delegates to
  `@livekit/track-processors` 0.7.2 (`BackgroundBlur` / `VirtualBackground`).
- Fallback — `BackgroundCustomProcessor.ts`, a hand-rolled CPU/canvas path for
  browsers without insertable-streams (Firefox etc.).

Both segment with MediaPipe's `selfie_segmenter` (binary person/background) and
consume a hard category mask (`outputCategoryMask: true`,
`outputConfidenceMasks: false`). Segmentation runs at ~256×144 and the binary
mask is upscaled to 720p+ with, at best, a box blur on the mask edge. There is
no edge-aware refinement, no light wrap, and no temporal smoothing. That
combination is exactly what produces the haze halo and the flickery, ambiguous
edge.

LiveKit's own WebGL path (`track-processors-js` `src/webgl/index.ts`,
`compositeShader.ts`) confirms it: the composite shader takes a single
`smoothstep` around the 0.5 mask threshold using the screen-space gradient. That
is a cosmetic softening of a binary mask, not the Google pipeline.

## What "good" actually is (all published, none proprietary)

Google published the full Meet pipeline
(research.google/blog/background-features-in-google-meet-powered-by-web-ml):

1. Low-res segmentation (MobileNetV3, 256×144) producing a soft confidence mask.
2. Softmax → probability per pixel.
3. Joint bilateral filter: refine the low-res mask against the full-res original
   frame so mask edges snap to real image edges (this is what kills the halo).
4. Light wrapping: let background light spill onto the foreground rim so the
   composite edge reads as natural rather than cut-out.
5. Separable blur (not gaussian pyramids) to avoid blur halos, all in WebGL2.

Volcomix/virtual-background is an open (Apache-2.0) reimplementation of that
exact pipeline — softmax + joint bilateral filter + light wrap as GLSL shaders
in `src/pipelines/webgl2/` (`jointBilateralFilterStage.ts`, `softmaxStage.ts`,
`backgroundImageStage.ts`, `backgroundBlurStage.ts`). This is our reference
code to port.

The delta between our current output and Google-quality is almost entirely
steps 3 and 4. The model matters less than the post-processing.

## Upstream / ecosystem findings

- suitenumerique/meet-matting exists: upstream's own research repo. It
  benchmarked nine real-time matting models on a 25-clip dataset. Conclusions:
  RVM wins on quality (IoU 0.972, boundary-F 0.942, best temporal stability) but
  is ~58 ms/frame; MediaPipe Selfie Multiclass is their recommended production
  balance (IoU 0.930, boundary-F 0.878, ~19 ms). Selfie Multiclass beats the
  `selfie_segmenter` we and LiveKit currently use on edges. The repo is phase 1
  (Python benchmark only) — no browser integration exists yet; it is explicitly
  experimental.
- Jitsi is no better than us today (pre-MediaPipe tflite stack); their fix is a
  GSoC-2025 idea, unwritten.
- RVM (github.com/PeterL1n/RobustVideoMatting) is the quality ceiling but
  GPL-3.0 and too slow for real-time browser — excluded.

## Plan

Build our own background processor for the Meet frontend, delivered as a patch
under `patches/meet/` and baked by the existing `meet-frontend-image` CI
workflow (no new infra, same pin/deploy path as everything else in this repo).

Pipeline, ported from Volcomix and Google's design:

1. Model: MediaPipe Selfie Multiclass, confidence masks
   (`outputConfidenceMasks: true`). Bake the `.tflite` into our
   `ghcr.io/open-suite/meet-frontend` image rather than CDN-loading it, so the
   demo has no external model dependency.
2. Softmax + joint bilateral filter stage (edge-aware mask refinement against
   the full-res frame) — the primary halo fix.
3. Light-wrap compositing for virtual backgrounds.
4. Temporal EMA on the confidence mask across frames — cheap, kills flicker,
   most of Zoom's perceived stability.
5. Keep a graceful fallback for no-WebGL2 / no-insertable-streams browsers
   (the existing custom processor path can stay as-is).

Integration point: replace or augment `UnifiedBackgroundTrackProcessor` so the
`BackgroundProcessorFactory` hands out the new processor when WebGL2 is
available, preserving the existing `ProcessorConfig` / `update()` interface used
by `EffectsConfiguration.tsx` so nothing else in the frontend changes.

## Verification (agent-run, before asking for a human look)

Chromium accepts a file as its fake webcam:
`--use-file-for-fake-video-capture=<file.y4m> --use-fake-device-for-media-stream`.
Harness lives in the scratchpad (`vb-harness/`), test footage is a real
person clip (xiph.org derf y4m).

- Drive the real processor headlessly over the clip, capture processed frames.
- A/B old (selfie_segmenter + smoothstep) vs new (multiclass + bilateral +
  light wrap + EMA), frame-by-frame screenshots.
- Quantify with the meet-matting metrics (boundary-F, flow-warping-error) where
  a reference alpha is available.
- Only after it is visibly better with clean edges on the harness, deploy to the
  demo and re-verify live via the existing meet flow; then hand screenshots to
  the human as the final quality gate.

## Constraints / decisions

- Everything lands in our own repos (`open-suite/*`). No third-party PRs.
- The upstream-contribution version — meet-matting phase 3, or a PR to
  `track-processors-js` — stays parked until explicitly approved. When
  approved, our processor is the natural basis for both.
- Licenses are compatible: Volcomix Apache-2.0, track-processors-js Apache-2.0,
  MediaPipe models Apache-2.0. RVM (GPL-3.0) is not used.

## Risk

WebGL shader work is iterative and "as good as Zoom" is a human judgment call.
Expect several working sessions, not one pass. The achievable agent-verifiable
bar is "clearly better than current, clean edges, no halo, stable" — the final
"ship it" is the human's eyes.

## POC result (2026-07-06) — approach validated

Built an A/B harness (Chromium + real MediaPipe segmentation + the WebGL
pipeline) over a hard 720p multi-person meeting-room clip (xiph derf vidyo1)
and compared the current path against the proposed one on identical frames.

Current path (selfie_segmenter binary mask + LiveKit smoothstep composite):
- Blur mode: all three faces blurred as background — the binary model fails on
  a wide multi-person shot.
- Virtual-bg mode: catastrophic — model inverts, people erased into
  head-shaped holes, room kept as "foreground".

Proposed path (selfie_multiclass confidence mask + joint bilateral filter +
light-wrap composite):
- Blur mode: all three people sharp, clean hair/glasses/shoulder edges, room
  correctly blurred, no halo.
- Virtual-bg mode: all three cleanly composited onto a replacement office
  image, natural edges, no haze.

The two changes that carry the win are the multiclass model (handles
multi-person, softer mask) and the joint bilateral edge refinement. This is
Google-Meet-class output where the current path is unusable. Remaining before
ship: temporal EMA for video stability, production integration into the meet
frontend (patch + baked model + CI), live verification. Harness lives in the
agent scratchpad (vb-harness/).

## Shipped (2026-07-06)

OpenSuiteBackgroundProcessor is live on the demo. patches/meet/opensuite-background.patch
adds the processor (multiclass confidence mask + joint bilateral + light wrap +
temporal EMA, WebGL2), makes it the primary path in BackgroundProcessorFactory
for any WebGL2 browser, and bakes the model + version-matched MediaPipe wasm
into ghcr.io/open-suite/meet-frontend (no CDN). Built by CI, deployed to demo.
Confirmed live: enabling Background blur in a real meeting loads
/opensuite-vision/{selfie_multiclass.tflite,wasm/*} and runs the pipeline with
zero errors. Person-quality validated in the offline+video harness (identical
processor code); see docs/meet-vb-poc. Temporal EMA (alpha 0.6) included.
Fake-webcam getUserMedia y4m format for a fully headless person A/B in the live
app remains the one thing not automated — the video-driven harness covers it
with the same code.
