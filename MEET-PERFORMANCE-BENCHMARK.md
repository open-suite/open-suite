# La Suite Meet performance benchmark — v1.20.0

## Result

The measured change defers MediaPipe and the optional LiveKit background
processor until a user enables a video effect. An ordinary pre-join no longer
downloads those dependencies.

The candidate changes only frontend loading. Backend startup, migrations,
sessions, logout, permissions, WebRTC configuration, and health endpoints are
unchanged.

### Browser baseline vs candidate

Chromium, 20 alternating pairs, fresh browser context per run, 4x CPU
throttling, 40 ms latency, 10 Mbps down / 5 Mbps up:

| Metric | Baseline min / p50 / p95 / max | Candidate min / p50 / p95 / max | p50 change |
|---|---:|---:|---:|
| Pre-join usable (ms) | 2020.0 / 2072.2 / 2155.9 / 2262.8 | 1993.1 / 2034.1 / 2139.4 / 2153.3 | -38.1 (-1.8%) |
| First contentful paint (ms) | 1696 / 1756 / 1852 / 1968 | 1608 / 1712 / 1832 / 1832 | -44 (-2.5%) |
| Room chunk response end (ms) | 866.2 / 881.0 / 902.4 / 941.7 | 783.1 / 794.8 / 846.3 / 861.6 | -86.2 (-9.8%) |
| DCL (ms) | 417.9 / 424.8 / 446.2 / 450.5 | 415.3 / 420.1 / 441.5 / 472.3 | -4.7 (-1.1%) |
| Long-task total (ms) | 499 / 519 / 578 / 625 | 459 / 507 / 545 / 588 | -12 (-2.3%) |
| JS encoded (KiB) | 556.26 / 556.26 / 556.26 / 556.26 | 511.79 / 511.79 / 511.79 / 511.79 | -44.46 (-8.0%) |
| JS decoded (KiB) | 1872.58 / 1872.58 / 1872.58 / 1872.58 | 1718.23 / 1718.23 / 1718.23 / 1718.23 | -154.35 (-8.2%) |
| Optional processor requests | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | 0 |

The baseline processor is inlined, so its zero optional *request* count is
structural; the candidate zero is the regression signal. The byte totals show
the baseline cost.

The candidate creates one more small chunk (32 rather than 31 JavaScript
requests) but transfers materially fewer bytes. The p50 interval from Room
chunk response to usable pre-join increased from 1180.5 ms to 1244.0 ms: the
Room chunk arrives earlier, but the remaining React/application work does not
become proportionally faster. Absolute usable time still improves slightly.
Tail improvements are encouraging but should not be treated as production SLO
data from a 20-pair local run.

### Room join setup

A separate 10-pair run clicked Join, served a deterministic room/token
response, answered LiveKit's connection-warming HEAD request, and measured the
first WebSocket signaling attempt. It deliberately stops before a signaling
response, ICE, TURN, or media publication:

| Metric | Baseline min / p50 / p95 / max | Candidate min / p50 / p95 / max | p50 change |
|---|---:|---:|---:|
| Room API request (ms) | 74.8 / 91.4 / 129.0 / 129.0 | 67.6 / 83.1 / 111.0 / 111.0 | -8.3 (-9.1%) |
| LiveKit preconnect HEAD (ms) | 212.4 / 235.1 / 282.1 / 282.1 | 204.3 / 218.0 / 246.1 / 246.1 | -17.1 (-7.3%) |
| Signaling attempt (ms) | 666.7 / 697.9 / 791.1 / 791.1 | 612.0 / 653.8 / 779.4 / 779.4 | -44.1 (-6.3%) |

This isolates frontend/API setup from real LiveKit network and WebRTC costs.

### Deferred effect path

Three candidate runs used Chromium's fake camera and the same WebGL2,
MediaPipe model, and WASM files baked into the image. Selecting the light blur
button loaded both deferred `vision_bundle` chunks and reached the selected
state without a page error:

| Metric | min / p50 / p95 / max |
|---|---:|
| Effect selected (ms) | 23672.3 / 23725.1 / 23741.1 / 23741.1 |
| MediaPipe chunk requests | 2 / 2 / 2 / 2 |

The long first-use time is expected under the shaped 10 Mbps connection: the
image contains a 16.37 MB segmentation model and the selected SIMD WASM is
9.42 MB. Before this change that cost was partly paid by every room visitor;
after it, only users who choose an effect pay it.

## Startup, migration, and static initialization

These are cached-image, newly-created-container measurements in an x86_64
Debian 12 orb using rootless Podman 4.3.1. They exclude image pull and
Kubernetes scheduling. The demo cluster was not restarted or deployed to, and
SSH credentials were unavailable, so these must not be represented as demo
cluster cold-pod timings.

| Workload | n | min / p50 / p95 / max |
|---|---:|---:|
| Frontend container create to HTTP 200 | 20 | 275.4 / 291.4 / 331.6 / 341.3 ms |
| Backend create to readiness `__lbheartbeat__` | 10 | 3988.2 / 4067.1 / 4281.0 / 4281.0 ms |
| Backend create to liveness `__heartbeat__` | 10 | 3971.5 / 4107.9 / 4309.2 / 4309.2 ms |
| Migration job, fresh v1.20.0 database | 10 | 5059.0 / 5301.4 / 5548.5 / 5548.5 ms |
| Migration job, no pending migrations | 10 | 4549.7 / 4782.5 / 4897.6 / 4897.6 ms |

Backend health measurements used a warm PostgreSQL 16 container with all
v1.20.0 migrations applied and `cached_db` sessions, matching the Open Suite
session setting. The Helm readiness/liveness probes have a five-second initial
delay, so Kubernetes will not observe the approximately four-second process
readiness before the first probe.

Static initialization is not on either pod startup path:

- Backend `collectstatic` runs in the image's `link-collector` build stage. The
  measured backend image already contains 470 files / 6.8 MiB under
  `/data/static`.
- Frontend assets are compiled in the image builder; the production entrypoint
  starts nginx directly.
- Database migration is a separate Helm job / `postdeploy` command, not part of
  Gunicorn startup.

The same startup distributions apply to baseline and candidate because the
optimization changes neither Docker runtime stage nor backend code.

## Methodology and reproduction

Baseline is upstream `suitenumerique/meet` tag `v1.20.0` (commit
`64819b36964359d2a415ae990fca7c14ac98c4ec`) with the existing Open Suite Meet
patches. Candidate adds `performance-lazy-background-processors.patch`.

Build both trees with Node 22, then run:

```sh
npm --prefix performance ci
npx --prefix performance playwright install chromium

MEET_BASELINE_DIST=/path/to/baseline/src/frontend/dist \
MEET_CANDIDATE_DIST=/path/to/candidate/src/frontend/dist \
MEET_BENCHMARK_SAMPLES=20 \
MEET_BENCHMARK_OUTPUT=meet-browser-result.json \
node meet-performance-benchmark.mjs
```

The server supplies deterministic mocks for public config and the current user.
The usable marker is the visible room-name input plus enabled Join button on a
direct room URL. `Room` chunk timing and total JavaScript transfer are collected
separately from the usable marker. No saved camera effect is configured in the
ordinary scenario, and the camera is off; camera-on/no-effect should be measured
separately if device-acquisition latency is in scope.

Add `MEET_BENCHMARK_JOIN=true` to click Join and measure the room API,
LiveKit connection-warming request, and first signaling attempt against the
local deterministic stub.

To verify actual deferred initialization, copy the image's
`/usr/share/nginx/html/opensuite-vision` directory into the candidate `dist`,
then run:

```sh
MEET_CANDIDATE_DIST=/path/to/candidate/src/frontend/dist \
MEET_BENCHMARK_EFFECT=true \
MEET_BENCHMARK_SAMPLES=3 \
node meet-performance-benchmark.mjs
```

Patch/source/build regression checks:

```sh
MEET_SOURCE_DIR=/path/to/patched-meet \
MEET_DIST_DIR=/path/to/patched-meet/src/frontend/dist \
node --test meet-performance-regression.test.mjs
```

The benchmark fails if an ordinary candidate run requests an optional
processor or an effect run does not request the deferred MediaPipe chunks.

## Correctness, risks, and remaining bottlenecks

Validated:

- all patches apply cleanly in workflow order to the exact pinned tag;
- TypeScript production build and ESLint complete successfully;
- ordinary room navigation makes zero MediaPipe/unified-processor requests;
- fake-camera blur initializes the real Open Suite processor and reaches its
  selected state;
- backend readiness and database-backed liveness return 200 after cold process
  creation;
- the optimization does not touch session/logout, permissions, migration,
  LiveKit/WebRTC, or health-check code.

Risks and limits:

- The lazy proxy reproduces the pinned LiveKit `ProcessorWrapper` capability
  checks. Upstream changes to those checks require review when Meet is upgraded.
- The modern Chromium/Open Suite effect path was exercised end to end. The
  LiveKit fallback and Firefox processor paths build and lint, but were not run
  with physical devices in this benchmark.
- The join setup test stops at the first WebSocket request. An authenticated
  signaling response, ICE/TURN setup, media publication, and remote-track
  rendering require a test account and a disposable cluster room; they were
  not faked or inferred.
- The largest emitted frontend artifact remains
  `NoiseSuppressorWorklet` (1.93 MB raw). Other large ordinary chunks are
  LiveKit client (466.6 KB raw) and primitives (450.2 KB raw).
- First effect use remains dominated by the 16.37 MB model and 9.42 MB WASM.
  Model quantization or a smaller segmentation model is a separate quality vs
  latency investigation and was deliberately not bundled into this PR.
- Backend process readiness (~4.1 s p50) and no-op migration jobs (~4.8 s p50)
  are larger server-side startup costs than nginx. No backend change was made
  because this investigation found no measured Meet-specific optimization that
  could safely preserve migrations, health semantics, and session correctness.
