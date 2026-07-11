# Open Suite application performance benchmark

This is the versioned performance ledger for the full applications behind the
portal. It complements the portal repository's widget benchmark: these journeys
open and render the real Nextcloud and Element applications.

## Latest summary

**Release:** Nextcloud sidecar compression `f576296`, Element compression
candidate `sha-5660a2d`

**Target:** `https://bridge.demo.opensuite.online`

**Captured:** 2026-07-11

**Result:** Nextcloud and Element compression accepted

### Browser KPIs

| Application | Profile | Ready p50 | Ready p75 | Ready p95 |  FCP p75 |  LCP p75 | Spinner p75 | Transfer p75 |
| ----------- | ------- | --------: | --------: | --------: | -------: | -------: | ----------: | -----------: |
| Nextcloud   | Cold    |  2,601 ms |  2,696 ms |  3,138 ms | 1,560 ms | 2,444 ms |        0 ms |    2,203 KiB |
| Nextcloud   | Warm    |    715 ms |    716 ms |    744 ms |   188 ms |   748 ms |        0 ms |       21 KiB |
| Element     | Cold    |  2,899 ms |  3,392 ms |  3,409 ms | 1,316 ms | 2,880 ms |      943 ms |    4,719 KiB |
| Element     | Warm    |    930 ms |    937 ms |    943 ms |   128 ms |   780 ms |      212 ms |        3 KiB |

Cold means an empty HTTP cache with an already established application session.
The app origin is unloaded between samples. Warm means a same-context reload.

### Payload KPIs

| Application | Cold requests p75 | Script count p75 | Script encoded p75 | Style encoded p75 |
| ----------- | ----------------: | ---------------: | -----------------: | ----------------: |
| Nextcloud   |                54 |               26 |          2,076 KiB |            33 KiB |
| Element     |                63 |               10 |          1,628 KiB |           130 KiB |

The accepted sidecar change recompresses eligible responses after shared-header
injection. Nextcloud's cold transfer fell from 9,015 to 2,203 KiB p75 (-76%):
JavaScript fell from 8,415 to 2,076 KiB and CSS from 162 to 33 KiB. Readiness
moved from 2,584 to 2,696 ms p75 inside observed run variance, so this is an
accepted network-efficiency improvement, not a claimed latency improvement.
Element's owned image now materializes an nginx performance template into the
chart's writable configuration volume. Its cold transfer fell from 15,315 to
4,719 KiB p75 (-69%); LCP improved 14% and spinner exposure improved 22%.

### Session bootstrap

The one-time SSO bootstrap took 3,714 ms for Nextcloud and 6,814 ms for Element.
Repeated Element bootstrap attempts before the declared run exposed HTTP 429
responses from Synapse's `rc_login.address` limiter. Synapse logs every caller
as the same cluster address (`10.42.0.1`), so the address limiter is effectively
global across users behind Traefik. The Synapse pod was restarted once to clear
the in-memory baseline bucket; the measured run then established one session
and reused it.

### Cluster baseline

- Node utilization at capture: 551 millicores (4%), 8,770 MiB memory (13%).
- All measured application Deployments and StatefulSets have no CPU requests,
  memory requests, CPU limits or memory limits.
- Largest idle containers: Docs backend 775 MiB, Collabora 596 MiB, Docs worker
  415 MiB, Nextcloud 395 MiB and Meet backend 385 MiB.
- Low node utilization means the current browser latency is not explained by
  sustained node saturation. Resource requests remain necessary for predictable
  scheduling and eviction behavior, but should be based on peak measurements.

## Method

The browser harness is `performance/apps.mjs` and the cluster collector is
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
