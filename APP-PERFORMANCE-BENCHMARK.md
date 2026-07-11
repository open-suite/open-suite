# Open Suite application performance benchmark

This is the versioned performance ledger for the full applications behind the
portal. It complements the portal repository's widget benchmark: these journeys
open and render the real Nextcloud and Element applications.

## Latest summary

**Release:** Nextcloud sidecar compression `f576296`, Element startup image
`sha-a6bbc34`, Synapse SSO login limits

**Target:** `https://bridge.demo.opensuite.online`

**Captured:** 2026-07-11

**Result:** compression and Element burst login fixes accepted; all long-running
suite containers now have measured resource requests without CPU limits

### Browser KPIs

| Application | Profile | Ready p50 | Ready p75 | Ready p95 |  FCP p75 |  LCP p75 | Spinner p75 | Transfer p75 |
| ----------- | ------- | --------: | --------: | --------: | -------: | -------: | ----------: | -----------: |
| Nextcloud   | Cold    |  2,601 ms |  2,696 ms |  3,138 ms | 1,560 ms | 2,444 ms |        0 ms |    2,203 KiB |
| Nextcloud   | Warm    |    715 ms |    716 ms |    744 ms |   188 ms |   748 ms |        0 ms |       21 KiB |
| Element     | Cold    |  2,455 ms |  2,910 ms |  2,916 ms |   520 ms | 2,476 ms |      619 ms |    4,714 KiB |
| Element     | Warm    |    930 ms |    932 ms |    943 ms |   132 ms |   772 ms |      209 ms |        3 KiB |

Cold means an empty HTTP cache with an already established application session.
The app origin is unloaded between samples. Warm means a same-context reload.

### Payload KPIs

| Application | Cold requests p75 | Script count p75 | Script encoded p75 | Style encoded p75 |
| ----------- | ----------------: | ---------------: | -----------------: | ----------------: |
| Nextcloud   |                54 |               26 |          2,076 KiB |            33 KiB |
| Element     |                63 |               10 |          1,622 KiB |           130 KiB |

The accepted sidecar change recompresses eligible responses after shared-header
injection. Nextcloud's cold transfer fell from 9,015 to 2,203 KiB p75 (-76%):
JavaScript fell from 8,415 to 2,076 KiB and CSS from 162 to 33 KiB. Readiness
moved from 2,584 to 2,696 ms p75 inside observed run variance, so this is an
accepted network-efficiency improvement, not a claimed latency improvement.
Element's owned image now materializes an nginx performance template into the
chart's writable configuration volume. Its cold transfer fell from 15,315 to
4,719 KiB p75 (-69%). The current image also preloads the late-discovered crypto
WebAssembly gate; against its immediate baseline, LCP improved 25% and spinner
exposure improved 47% without changing payload size.

### Session bootstrap

The one-time SSO bootstrap took 3,714 ms for Nextcloud and 6,814 ms for Element.
Repeated Element bootstrap attempts before the declared run exposed HTTP 429
responses from Synapse's `rc_login.address` limiter. The listener trusts
forwarded addresses, but an office or government network still legitimately
groups many users behind one public NAT address. The default bucket allowed the
first five logins and falsely rejected the next four measured attempts. With a
30-login address burst, all 10 candidate attempts succeeded and no Matrix 429
was observed. Per-account and failed-attempt buckets remain at five.

### Cluster state

- Node utilization after resource rollout: 623 millicores (5%), 8,406 MiB
  memory (13%).
- All 43 long-running containers in the measured suite namespaces have CPU and
  memory requests; none has a CPU limit. Total cluster requests, including
  Kubernetes system workloads, are 2,220 millicores (18%) and 7,868 MiB (12%).
- Largest idle containers: Docs backend 775 MiB, Collabora 596 MiB, Docs worker
  415 MiB, Nextcloud 395 MiB and Meet backend 385 MiB.
- Low node utilization means the current browser latency is not explained by
  sustained node saturation. Requests protect these working sets from
  contention and eviction; absent CPU limits allow short interactive bursts.

## Method

The browser harnesses are `performance/apps.mjs` and
`performance/element-login.mjs`; the cluster collector is
`performance/cluster-snapshot.sh`.

```bash
cd performance
npm ci
npx playwright install chromium
BENCHMARK_USER=johndoe \
BENCHMARK_PASS='<demo password>' \
BENCHMARK_SAMPLES=5 \
BENCHMARK_LABEL='<release-or-candidate>' \
BENCHMARK_OUTPUT=/tmp/open-suite-apps.json \
npm run benchmark:apps
```

The Element login benchmark creates isolated browser contexts so every attempt
must complete the full SSO and Matrix login flow:

```bash
BENCHMARK_USER=johndoe \
BENCHMARK_PASS='<demo password>' \
BENCHMARK_ATTEMPTS=10 \
npm run benchmark:element-login
```

Protocol:

- Chromium 140.0.7339.186, headless, 1440x900, runner in the Netherlands.
- Authenticate once through the portal and establish each app session once.
- Clear Chromium's HTTP cache before each cold sample, unload the app origin by
  returning to the portal, then use the visible shared header to open the app.
- Reload the app in the same context for its paired warm sample.
- Nextcloud is ready when the Documents result count is visible. Element is
  ready when at least one room-list item is visible.
- Collect readiness, navigation timing, FCP, LCP, long tasks, generic spinner
  exposure, request counts and Resource Timing encoded/decoded sizes.
- Raw JSON and cluster snapshots are local artifacts. Summaries and anomalous
  discarded attempts are committed here.

## Targets

| KPI                         |  Initial target |
| --------------------------- | --------------: |
| Established-session ready   | <= 1,000 ms p75 |
| Warm ready                  |   <= 500 ms p75 |
| FCP                         |   <= 500 ms p75 |
| LCP                         | <= 1,000 ms p75 |
| Blocking spinner exposure   |            0 ms |
| Cold compressed transfer    |    <= 2,000 KiB |
| Login rate-limit false fail |              0% |

## History

### 5. Accepted: preload Element's crypto WebAssembly gate - `sha-a6bbc34` - 2026-07-11

| Element KPI | Baseline p75 | Candidate p75 | Change |
| ----------- | -----------: | ------------: | -----: |
| Cold ready  |     3,429 ms |      2,910 ms |   -15% |
| FCP         |     1,268 ms |        520 ms |   -59% |
| LCP         |     3,292 ms |      2,476 ms |   -25% |
| Spinner     |     1,171 ms |        619 ms |   -47% |
| Transfer    |    4,714 KiB |     4,714 KiB |     0% |
| Warm ready  |       932 ms |        932 ms |     0% |

Accepted. The resource waterfall showed Element discovering its 1.8 MiB Rust
E2EE WebAssembly module around 2.6 seconds, then blocking Matrix initialization
on the transfer. The owned image now discovers the exact hashed module at build
time and adds one HTML preload. In the candidate waterfall it started at 71 ms,
finished at 619 ms, appeared exactly once, and was reused by Element. Encryption
functionality and total payload are unchanged.

### 4. Accepted: size every suite workload from a load sample - 2026-07-11

| KPI                              | Before | After |
| -------------------------------- | -----: | ----: |
| Containers with resource requests|  0/43  | 43/43 |
| Containers with CPU limits       |  0/43  |  0/43 |
| Nextcloud cold ready p75         | 3,085 ms | 3,123 ms |
| Nextcloud warm ready p75         |   769 ms |   714 ms |
| Element cold ready p75           | 3,449 ms | 3,419 ms |
| Element warm ready p75           |   953 ms |   937 ms |

Accepted. A 100-second, two-second-interval load sample captured 1,462
per-container observations while the browser workload exercised Nextcloud and
Element. Requests add working-set headroom to all applications, databases,
caches, object stores, proxies and the auth gate. No CPU limits were introduced.
The three-sample browser comparison showed no meaningful regression. Enabling
real resource values also exposed and fixed upstream wiring errors where Meet
swapped frontend/backend keys and Docs assigned backend resources to its
frontend and y-provider.

### 3. Accepted: make Element SSO login bursts reliable - 2026-07-11

| Element login KPI       | Baseline | Candidate |
| ----------------------- | -------: | --------: |
| Successful fresh logins |     5/10 |     10/10 |
| Matrix 429 attempts     |     4/10 |      0/10 |
| Candidate elapsed range |        - | 7.7-8.6 s |

Accepted. The Synapse chart now renders explicit address, account and failed
attempt login buckets. Because Keycloak is the only authentication mechanism,
the address-wide bucket allows a 30-login office burst while account and failed
attempt protection remain at five. This also fixes the existing `perSeconde`
typo so the declared message rate is actually rendered.

### 2. Accepted: compress Element static assets - `sha-5660a2d` - 2026-07-11

| Element cold KPI | Baseline p75 | Candidate p75 | Change |
| ---------------- | -----------: | ------------: | -----: |
| Ready            |     3,409 ms |      3,392 ms |    -1% |
| FCP              |     1,364 ms |      1,316 ms |    -4% |
| LCP              |     3,336 ms |      2,880 ms |   -14% |
| Spinner          |     1,213 ms |        943 ms |   -22% |
| Total transfer   |   15,315 KiB |     4,719 KiB |   -69% |
| Script encoded   |    6,262 KiB |     1,628 KiB |   -74% |
| Style encoded    |      945 KiB |       130 KiB |   -86% |

Accepted. Element's nginx entrypoint writes configuration from templates into
the chart's mounted `conf.d` volume, so the owned image installs compression as
a template rather than a masked final config file. The deployment pin now uses
the immutable candidate SHA tag. Remaining cold readiness is dominated by
Element/Matrix initialization rather than asset transfer.

### 1. Accepted: recompress shared-header sidecar responses - `f576296` - 2026-07-11

| Nextcloud cold KPI | Baseline p75 | Candidate p75 | Change |
| ------------------ | -----------: | ------------: | -----: |
| Ready              |     2,584 ms |      2,696 ms |    +4% |
| FCP                |     1,596 ms |      1,560 ms |    -2% |
| LCP                |     2,528 ms |      2,444 ms |    -3% |
| Total transfer     |    9,015 KiB |     2,203 KiB |   -76% |
| Script encoded     |    8,415 KiB |     2,076 KiB |   -75% |
| Style encoded      |      162 KiB |        33 KiB |   -80% |

Accepted. The shared-header proxy must request uncompressed upstream HTML for
`sub_filter`, but now gzip-compresses eligible output for the browser. Cache
headers, WebSocket/SSE behavior and already-compressed formats are unchanged.
The sidecar remained below one reported millicore after the benchmark; node CPU
remained 4%.

### 0. Baseline - 2026-07-11

Initial five-sample Nextcloud and Element baseline. Both applications are
network-heavy on an empty cache, Element blocks on a visible spinner, Synapse's
login limiter aliases callers to one address, and no application workload has
resource requests or limits.
