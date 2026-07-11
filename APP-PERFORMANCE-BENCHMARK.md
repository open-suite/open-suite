# Open Suite application performance benchmark

This is the versioned performance ledger for the full applications behind the
portal. It complements the portal repository's widget benchmark: these journeys
open and render the real Nextcloud and Element applications.

## Latest summary

**Release:** distribution `dc1cd8e`, Nextcloud `sha-03c989f`, Element `v1.12.21`

**Target:** `https://bridge.demo.opensuite.online`

**Captured:** 2026-07-11

**Result:** Initial application and cluster baseline

### Browser KPIs

| Application | Profile | Ready p50 | Ready p75 | Ready p95 |  FCP p75 |  LCP p75 | Spinner p75 | Transfer p75 |
| ----------- | ------- | --------: | --------: | --------: | -------: | -------: | ----------: | -----------: |
| Nextcloud   | Cold    |  2,138 ms |  2,584 ms |  3,121 ms | 1,596 ms | 2,528 ms |        0 ms |    9,015 KiB |
| Nextcloud   | Warm    |    711 ms |    730 ms |    805 ms |   180 ms |   724 ms |        0 ms |       49 KiB |
| Element     | Cold    |  3,401 ms |  3,409 ms |  3,432 ms | 1,364 ms | 3,336 ms |    1,213 ms |   15,315 KiB |
| Element     | Warm    |    926 ms |    934 ms |    948 ms |   136 ms |   808 ms |      210 ms |        3 KiB |

Cold means an empty HTTP cache with an already established application session.
The app origin is unloaded between samples. Warm means a same-context reload.

### Payload KPIs

| Application | Cold requests p75 | Script count p75 | Script encoded p75 | Style encoded p75 |
| ----------- | ----------------: | ---------------: | -----------------: | ----------------: |
| Nextcloud   |                54 |               26 |          8,415 KiB |           162 KiB |
| Element     |                63 |               10 |          6,262 KiB |           945 KiB |

For both applications, encoded and decoded bytes were identical in every cold
sample. The live delivery path is not compressing these assets. Nextcloud's
shared-header sidecar clears upstream `Accept-Encoding` so nginx can inject the
header script, but does not recompress the client response. Element's upstream
nginx image also delivers its bundles uncompressed.

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

### 0. Baseline - 2026-07-11

Initial five-sample Nextcloud and Element baseline. Both applications are
network-heavy on an empty cache, Element blocks on a visible spinner, Synapse's
login limiter aliases callers to one address, and no application workload has
resource requests or limits.
