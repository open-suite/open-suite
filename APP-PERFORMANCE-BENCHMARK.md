# Open Suite application performance benchmark

This is the versioned performance ledger for the full applications behind the
portal. It complements the portal repository's widget benchmark: these journeys
open and render the real Nextcloud and Element applications.

## Latest summary

On November 18, 2026 the live demo ran portal `066e380` with distribution
`5546fef`. A GitHub-hosted Ubuntu 24.04 runner measured 20 warm portal
reloads. At p75 the shell appeared at 370 ms, the dashboard at 780 ms,
first widget data at 981 ms, and the last required widget response at
1,464 ms. Global spinner exposure was zero at p75.

The same runner completed all ten cold/warm pairs per application on the
first attempt. Cold clears the HTTP cache while retaining the app session.
Warm reloads the destination in that session. Nextcloud readiness required
the active Documents section and visible result heading. Element readiness
required the first visible room-list item.

| Journey | Ready p50 | Ready p75 | Interquartile range | Slowest |
| --- | ---: | ---: | ---: | ---: |
| Nextcloud Documents, cold | 3.66 s | 4.94 s | 2.00 s | 8.98 s |
| Nextcloud Documents, warm | 1.24 s | 1.77 s | 0.60 s | 15.93 s |
| Element room list, cold | 6.02 s | 6.05 s | 0.99 s | 6.07 s |
| Element room list, warm | 2.09 s | 2.09 s | 0.01 s | 2.11 s |

The pre-deploy dashboard run used a different runner. These measurements
establish a new CI baseline. They cover three surfaces from the earlier
suite-wide audit. [Post-deploy benchmark](https://github.com/open-suite/open-suite/actions/runs/44276752689)

Three pre-deploy transition runs passed fresh login, Calendar, Documents and
the Office file lifecycle. Chat opened, but its exact deep-link assertion
failed in all three runs. Whiteboard lacked a fixture in all three.
[Transition results](https://github.com/open-suite/open-suite/actions/runs/44272787881)

### How much does the runner change the result?

The November CI job ran in Azure West US 2. July's runner was in the
Netherlands. To isolate network delay, we ran the same November application
benchmark with Playwright 1.55.1 and Chromium 140 on the demo host. A
temporary two-vCPU-limited browser pod used the live ingress and the same
demo account throughout. Linux netem added 0, 30, then 150 ms of outbound
packet delay on the browser pod alone. Each condition completed ten cold
and ten warm samples per app. The 30 ms and 150 ms paths are simulations.
Bandwidth, packet loss and July's runner hardware were not reproduced.

| Ready p75 | July, Netherlands | Current, 0 ms added | Current, 30 ms added | Current, 150 ms added | Current, West US 2 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Nextcloud cold | 2.81 s | 2.68 s | 2.22 s | 3.19 s | 4.94 s |
| Nextcloud warm | 0.78 s | 0.88 s | 0.94 s | 1.18 s | 1.77 s |
| Element cold | 2.89 s | 1.95 s | 2.65 s | 5.54 s | 6.05 s |
| Element warm | 0.94 s | 0.64 s | 1.02 s | 2.09 s | 2.09 s |

For Element, added latency reproduced the warm slowdown and most of the
cold slowdown. A separate test served the July `sha-a6bbc34` and current
`sha-dbca029` Element frontend images on loopback to the same browser.
Across two five-sample blocks per image in July/current/current/July order,
cold startup to the visible SSO action took 859 ms p75 in July and 822 ms
with the current image. That comparison covers the frontend sign-in screen.

Nextcloud also slowed with added delay, but 150 ms alone did not reproduce
the original CI timings. At 30 ms the current cold journey finished faster
than July's and transferred 2,156 KiB against July's 2,203 KiB. Warm
readiness was 156 ms slower. In a separate ten-pair run at 30 ms we timed
both readiness markers on each navigation. On warm reloads their median
paired difference was under 1 ms. On five cold launches the current marker
appeared about half a second earlier. The marker change does not explain
the large increases. July had five samples and no preserved runner
calibration. A release-to-release warm regression of 156 ms remains
unresolved.

A second US West CI runner measured the same deployment at 3.31 s cold and
1.15 s warm for Nextcloud (p75). Its slowest warm reload was 1.23 s, versus
15.93 s in the first run. Element repeated at 6.05 s cold and 2.07 s warm.
The second Nextcloud run closely matches the 150 ms experiment. The first
run also had substantial run-to-run variation on the unchanged deployment.
[Repeat CI benchmark](https://github.com/open-suite/open-suite/actions/runs/44285481311)

## July 11 benchmark

**Release:** Nextcloud sidecar compression `f576296`, Element startup image
`sha-a6bbc34`, Synapse SSO login limits

**Target:** `https://bridge.demo.opensuite.online`

**Captured:** 2026-07-11

**Result:** compression and Element burst login fixes accepted; all long-running
suite containers now have measured resource requests without CPU limits

**Historical sample/environment note:** the browser tables below use five
samples per application/profile on Chromium 140.0.7339.186, headless 1440x900,
from a Netherlands runner. They were captured with the original schema, which
did not retain IQR or MAD, so variance is unavailable and p95 is only the sample
maximum. New claims must follow the schema 2 comparison policy in Method.

### Browser KPIs

| Application | Profile | Ready p50 | Ready p75 | Ready p95 |  FCP p75 |  LCP p75 | Spinner p75 | Transfer p75 |
| ----------- | ------- | --------: | --------: | --------: | -------: | -------: | ----------: | -----------: |
| Nextcloud   | Cold    |  2,624 ms |  2,808 ms |  3,898 ms | 1,548 ms | 2,524 ms |        0 ms |    2,203 KiB |
| Nextcloud   | Warm    |    703 ms |    780 ms |  1,318 ms |   184 ms |   736 ms |        0 ms |       21 KiB |
| Element     | Cold    |  2,886 ms |  2,894 ms |  2,914 ms | 1,300 ms | 2,688 ms |      590 ms |    4,719 KiB |
| Element     | Warm    |    939 ms |    941 ms |    959 ms |   132 ms |   804 ms |      212 ms |        3 KiB |

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
moved from 2,584 to 2,696 ms p75 (+4%) in the small historical run, so this is
an accepted network-efficiency improvement, not a claimed latency improvement.
Element's owned image now materializes an nginx performance template into the
chart's writable configuration volume. Its cold transfer fell from 15,315 to
4,719 KiB p75 (-69%). The current image also preloads the late-discovered crypto
WebAssembly gate; against its immediate baseline, LCP improved 25% and spinner
exposure improved 47% without changing payload size.

### Session bootstrap

The final one-time SSO bootstrap took 3,814 ms for Nextcloud and 5,264 ms for
Element.
Repeated Element bootstrap attempts before the declared run exposed HTTP 429
responses from Synapse's `rc_login.address` limiter. The listener trusts
forwarded addresses, but an office or government network still legitimately
groups many users behind one public NAT address. The default bucket allowed the
first five logins and falsely rejected the next four measured attempts. With a
30-login address burst, all 10 candidate attempts succeeded and no Matrix 429
was observed. The final merged-state check also passed 10/10 with zero 429s.
Per-account and failed-attempt buckets remain at five.

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
- For Portal, Docs, Grist, Nextcloud and Messages, the shared sidecar emits one
  `X-Upstream-Header-Time` field. Its value is normally one numeric duration in
  seconds; retries are comma-separated and internal redirects separate groups
  with a colon (for example `0.123, 0.456 : 0.789`). An entry can be `-` when
  that attempt did not complete its upstream response headers, including valid
  sequences such as `-, 0.042` and `-, 0.031 : 0.044`; the parser preserves
  those entries explicitly as `null` rather than treating them as malformed.
  The benchmark validates this grammar and requires exactly one field on each
  measured main-document response from a covered sidecar app using Playwright's
  raw response-header array. This is automation/CDP observability, not an API
  for cross-origin page JavaScript; the header is not CORS-exposed and the
  benchmark must not broaden CORS to read it.
- Raw JSON and cluster snapshots are local artifacts. Summaries and anomalous
  discarded attempts are committed here.

Schema 2 reports must identify the baseline and deployed revisions, workload,
requested and completed sample counts, discarded attempts, runner class and
coarse region, OS/CPU/browser/Node versions, and whether the checkout was dirty.
Metrics use linearly interpolated type-7 quantiles plus IQR, MAD, scaled MAD
(`1.4826 × MAD`), and robust CV. Use at least 10 samples in each comparable
baseline/candidate run for a measured-improvement claim. With fewer than 20
samples p95 is descriptive only. Baseline and candidate must use the same
workload and materially compatible environments; otherwise rerun rather than
normalizing unlike measurements.

Every future history entry must include:

- baseline and candidate/deployment revisions;
- exact workload and correctness guard;
- requested, completed, and discarded sample counts;
- runner environment and any relevant network profile;
- median/p75 with IQR or scaled MAD for latency, plus payload/resource variance
  where applicable;
- rejected or anomalous attempts and whether the delta exceeds observed spread.

Historical schema 1 entries below predate this policy. Their sample counts are
stated where known, but missing variance must remain “unavailable” rather than
being reconstructed or implied.

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

### 6. Candidate: serve precompressed Element bundles - 2026-07-18

**Status:** measured locally against the exact pinned image; demo rollout and
end-to-end browser confirmation remain pending. This is not a live-demo latency
claim.

| 21-resource origin workload | Baseline | Candidate | Change |
| --------------------------- | -------: | --------: | -----: |
| Elapsed p50 (IQR) | 368.2 ms (1.7 ms) | 10.8 ms (0.8 ms) | -97.1% |
| Elapsed p75 | 369.5 ms | 11.3 ms | -96.9% |
| Encoded bytes | 4,159,588 | 4,163,958 | +0.1% |
| Gzip responses | 21/21 | 21/21 | 0 |

Baseline and candidate used `ghcr.io/open-suite/element-web:sha-a11ee66`
as their identical amd64 root filesystem and nginx 1.31.2. The candidate then
ran this branch's precompression script and enabled `gzip_static`; it was not a
published image. The benchmark forced one nginx worker and fetched the 21
startup textual resources in `performance/element-startup-resources.txt` over
HTTP/1.1 with six keep-alive sockets and `Accept-Encoding: gzip`. After five
warmups, 30 samples per variant ran in alternating order on the same 16-vCPU
x86_64 Amp orb. The final run used clean revision `2efeadb`; the manifest
SHA-256 was
`1449b81f7d41b8884f3567e7b0d546fbfd598672a15b292006ee3e3be5a2fd42`.
Baseline used dynamic gzip level 5; candidate used level-5 build-time gzip for
the hashed `bundles/` directory plus `gzip_static on`. Non-bundle responses
still used identical dynamic gzip, which is why candidate elapsed time did not
fall to zero.

The correctness preflight matched status, decoded SHA-256, content type and
encoding, cache policy, `Vary`, and `Last-Modified` for all 21 responses. All 73
generated `.gz` files also decoded byte-for-byte to their source bundles. The
candidate retained `Vary: Accept-Encoding`; identity requests still use the
original files. Encoded bytes increased 0.1% because nginx's streaming output
and deterministic `gzip -5 -n` are not byte-identical encoders.

Representation headers intentionally differ: dynamic gzip returns a weak ETag
for the source while `gzip_static` returns a strong ETag and `Accept-Ranges` for
the compressed representation. That can cause one revalidation miss when this
image replaces the baseline but does not reuse stale content. Production nginx
uses `worker_processes auto`, not the benchmark's one worker, so the durable
result is avoided compression CPU per cold response; the -97% local origin wall
time is not presented as an end-to-end latency forecast.

The candidate Dockerfile built successfully into local OCI manifest
`sha256:124eee37187501946c9432b663968a1828071fdbaec2d2cec58b7d2683065762`.
Its final application layer was 7.70 MB versus 0.33 MB across the published
image's existing patch layers: a measured 7.37 MB addition, or 12.2% of the
baseline's 60.17 MB registry layers. That image-pull cost is accepted for
review, not hidden; it is paid once per uncached node rather than on every cold
bundle response. The built candidate contained exactly 73 `.gz` files and none
outside the content-hashed bundle directory, so runtime-generated `config.json`
and other mutable paths cannot be shadowed by stale gzip files.

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
