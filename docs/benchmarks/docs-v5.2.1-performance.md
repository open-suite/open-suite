# Docs v5.2.1 cold-start investigation

Date: 2026-07-20

Distribution base: `cfd2129853f8aac1dc2a69c923928780138f1f96`

Pinned infra: `ef1d796211ad8624ad5a78cb9a828b0926c2933b`

Docs source/tag: `v5.2.1` (`a43883caf0bf236cf0a6725fc705621afe1339a8`)

## Result

The dominant distribution-owned cold-start cost was the Docs chart's fixed
10-second initial readiness delay plus its 10-second retry cadence. The
containers were usable much earlier: frontend in 0.37s, y-provider in 2.46s,
and backend in 4.66s. A missed first backend check could add another 10s.

The change adds startup probes and lets the same existing readiness endpoints
decide readiness immediately. It does **not** replace an endpoint, skip an
initialization step, or loosen readiness failure/timeout thresholds.

| Metric (median) | Before | After | Change |
| --- | ---: | ---: | ---: |
| Backend Kubernetes Ready | 13.348s | 8.361s | -37.4% |
| Frontend Kubernetes Ready | 10.442s | 1.991s | -80.9% |
| y-provider Kubernetes Ready | 10.523s | 3.979s | -62.2% |
| All three pods Ready, concurrent cold start | 13.539s | 7.732s | -42.9% |
| First owned-document list usable from pod creation | 20.510s | 9.226s | -55.0% |
| First editor + content + WebSocket usable from pod creation | 22.886s | 11.375s | -50.3% |
| Fresh migration plus post-migration grants | 8.587s | 7.709s | -10.2% |
| Grant substep only | 1.10s | 0.23s | -79.1% |

The document-open route after the list was already usable changed only from
2.202s to 2.078s (-5.6%, within the variance expected from this sample size).
This is evidence that the PR improves startup gating rather than hiding editor
work.

## Images and runtime

All images were pulled once, pinned by digest, then preloaded into k3d. Image
pull and registry time are intentionally excluded.

| Component | Image digest | Local size |
| --- | --- | ---: |
| Backend and worker | `lasuite/impress-backend@sha256:a1328ab4b4297e35b7552fe512868d7c4070991d813c7ef00e52d2653b9082b5` | 449.8MB |
| Frontend | `lasuite/impress-frontend@sha256:743b7884db607ae894d4eaccdfd603756040dfba41f572d23317e4eb6ff918fc` | 191.9MB |
| y-provider | `lasuite/impress-y-provider@sha256:f5732737d749ff8a479af8dfcf235451e11279d88175eeec26625711e5a766d2` | 830.6MB |

The backend image uses Python 3.13.13 and four Uvicorn workers
(`WEB_CONCURRENCY=4`). The frontend is nginx 1.31.1 serving a prebuilt Next.js
site; it is not a runtime Next.js server. The y-provider runs Node 22.22.3.

The isolated environment used PostgreSQL 16.14, Redis 8.2.1, a private MinIO
`RELEASE.2025-07-23T15-54-02Z` bucket, Docker 20.10.24, k3d 5.8.3 / k3s
1.31.5, kubectl 1.33.3, Helm 3.18.4, and Playwright 1.55.1. The orb had 16
vCPUs and 31GiB RAM.

## Measurements

### Process startup

Seven containers per component were created before timing, then timed from
`docker start` until the production usability marker. Dependencies and images
were warm, but every application container and process was new.

Markers:

- backend: HTTP 200 from `/__heartbeat__`;
- worker: Celery's `ready.` log marker with the chart's `--autoscale=9,3`;
- frontend: HTTP 200 from `/`;
- y-provider: HTTP 200 from `/ping`.

| Component | Raw samples (ms) | Median | Maximum | Memory after marker |
| --- | --- | ---: | ---: | ---: |
| Backend | 4616.3, 4687.2, 5020.8, 4664.0, 4535.2, 4493.4, 4680.5 | 4664.0ms | 5020.8ms | ~740MiB |
| Celery worker | 6011.0, 5923.6, 5947.2, 6113.0, 5975.3, 6005.7, 5930.4 | 5975.3ms | 6113.0ms | ~411MiB |
| Frontend | 348.5, 405.9, 357.7, 353.6, 366.6, 377.9, 400.3 | 366.6ms | 405.9ms | ~12.2MiB |
| y-provider | 2446.0, 2489.2, 2460.2, 2414.6, 2393.8, 2469.6, 2474.4 | 2460.2ms | 2489.2ms | ~190-198MiB |

Reproduce after creating a Docker network and supplying production-equivalent
backend/y-provider env files:

```bash
python3 performance/docs-v5.2.1-cold-start.py backend \
  --runtime 'sudo docker' --network docs-v5.2.1-benchmark \
  --env-file /path/to/backend.env --count 7
python3 performance/docs-v5.2.1-cold-start.py worker \
  --runtime 'sudo docker' --network docs-v5.2.1-benchmark \
  --env-file /path/to/backend.env --count 7
python3 performance/docs-v5.2.1-cold-start.py frontend \
  --runtime 'sudo docker' --network docs-v5.2.1-benchmark --count 7
python3 performance/docs-v5.2.1-cold-start.py y-provider \
  --runtime 'sudo docker' --network docs-v5.2.1-benchmark \
  --env-file /path/to/y-provider.env --count 7
```

### Kubernetes readiness

A single-node k3d cluster used `--flannel-backend=host-gw`. Exact release
images were loaded with `k3d image import`; no pull occurred during a sample.
PostgreSQL, Redis, and MinIO remained running between samples. Each variant had
one discarded warm-up. Five measured samples were alternated before/after to
limit ordering effects. Timing began immediately before `kubectl apply` and
ended when the Pod Ready condition became true.

The before manifests reproduce chart v0.1.0 defaults: readiness initial delay
10s, period 10s, timeout 5s, failure threshold 3, success threshold 1. The
after manifests use a startup probe with period 1s, failure threshold 30, and
readiness initial delay 0s / period 1s. Backend startup retains the existing 5s
heartbeat response tolerance; the static frontend and `/ping` use 1s. All
other fields are the chart defaults.

| Component | Before samples (ms) | After samples (ms) |
| --- | --- | --- |
| Backend | 23013.5, 23189.5, 13348.4, 13247.4, 13258.2 | 8595.8, 8379.2, 8360.9, 8312.9, 8163.8 |
| Frontend | 10437.5, 10477.1, 10441.9, 10441.9, 10542.8 | 2011.2, 1984.7, 1976.4, 2010.3, 1990.5 |
| y-provider | 10541.6, 10508.6, 10522.8, 10534.6, 10473.6 | 3492.9, 3468.9, 4023.9, 4032.6, 3979.4 |

The backend's two ~23s outliers missed the first coarse readiness window and
waited for the next 10-second check. That behavior is precisely what the
startup/readiness scheduling change removes.

### First list, first document, and collaboration

The production-configured stack had 25 documents owned by the test user. It
used PostgreSQL, Redis-backed Django sessions, a private MinIO bucket, the
frontend, backend, y-provider, and a reverse proxy that preserved the same
forwarded headers and WebSocket upgrade path as ingress.

For the full cold path, backend, frontend, and y-provider pods were created
concurrently. Once all three were Ready, the proxy was attached and a new
headless Chromium process navigated to Docs. The end-to-end clock started
before pod creation and ended at the actual browser marker, so it includes pod
scheduling, readiness, proxy attachment, browser startup, and application
work. Each variant had a discarded full-path warm-up. Three measured samples
were alternated before/after.

Browser markers:

- list usable: `docs-grid` visible and `grid-loader` hidden after the 200 list
  response finished;
- document usable: detail and object-backed content requests completed, the
  collaboration WebSocket opened, `.ProseMirror` and the document title were
  visible;
- collaboration: a unique string typed in browser one became visible in
  browser two;
- permission: a separate authenticated user with no access received HTTP 403
  for the document detail.

| Metric | Before samples (ms) | After samples (ms) |
| --- | --- | --- |
| All pods Ready | 20702.5, 13337.7, 13539.0 | 5606.9, 7731.8, 7808.0 |
| Cold list usable | 27518.1, 17519.0, 20509.5 | 9525.6, 9174.9, 9225.8 |
| Cold first document usable | 29814.1, 19778.0, 22885.5 | 11662.6, 11284.9, 11374.8 |
| List after traffic began | 6073.7, 3400.4, 6192.2 | 3170.3, 645.8, 603.4 |
| Document open after list | 2237.0, 2201.5, 2128.3 | 2078.4, 2048.5, 2090.6 |
| Remote edit visible | 161.5, 151.6, 156.4 | 154.0, 157.5, 175.0 |

The first-list spread is real cold-worker/cache variance. A separate
seven-sample run against an already-running stack had medians of 566.0ms for
list usability, 983.6ms for document open, and 157.0ms for remote-edit
propagation. It is reported separately rather than mixed into cold startup.

Run the browser assertions against an already-routed stack with an owner and a
no-access user's Redis-backed session keys:

```bash
npm ci --prefix performance
DOCS_BENCHMARK_URL=https://docs.example.test \
DOCS_BENCHMARK_SESSION_FILE=/secure/path/owner-session \
DOCS_BENCHMARK_UNAUTHORIZED_SESSION_FILE=/secure/path/no-access-session \
node performance/docs-v5.2.1-browser.mjs
```

Set `DOCS_BENCHMARK_CHECK_PERSISTENCE=true` for the longer check. It waits for
the application's 60-second content-save interval, requires a successful
content PATCH, and confirms that a fresh content GET differs from the pre-edit
object. That mode also requires `DOCS_BENCHMARK_CSRF_TOKEN_FILE` containing the
32-character CSRF token installed in the benchmark browser's `csrftoken`
cookie.

The synthetic local sessions intentionally bypassed OIDC. Consequently the
frontend's unrelated first-login user-profile PATCH returned 403 in this
harness, and disabling service workers to avoid cache effects emitted a
registration warning. Neither error affected the asserted document list,
document permission, content, or collaboration paths.

### Migration and static setup

A fresh PostgreSQL database owned by the app role was created for every
sample. Migrations ran as the admin role, exactly as `migrateDbCredentials`
does. The timed container ran all migrations and then either the existing
second `manage.py shell` grant step or the new direct psycopg grant step. Five
samples were alternated:

- before: 8.737, 8.581, 8.587, 8.676, 8.419s (median 8.587s);
- after: 7.782, 7.709, 7.633, 7.634, 7.761s (median 7.709s).

Measuring the grant substep in an already-started container isolated the
reason: Django startup took 1.09, 1.10, 1.11, 1.11, 1.12, 1.09, 1.09s, while
direct psycopg took 0.22, 0.22, 0.24, 0.28, 0.24, 0.23, 0.22s.

There is no deploy-time `collectstatic` to optimize. The backend image already
contains 478 files / 6.8MiB under `/data/static`; collecting them is an image
build step.

## Implementation and invariants

The value patch uses fields already supported by the vendored upstream chart:

- backend startup `/__heartbeat__`, readiness remains `/__lbheartbeat__`;
- frontend startup/readiness remain `/`;
- y-provider startup/readiness remain `/ping`;
- existing liveness endpoints and all liveness/readiness timeout, failure, and
  success semantics remain intact;
- startup probes gate (rather than replace) the existing liveness/readiness
  checks; backend keeps the old 5-second heartbeat response tolerance while
  frontend and y-provider use 1 second;

The migration still runs in full. Only the second Django initialization is
removed. The replacement uses the backend image's existing psycopg 3
dependency, discovers the database owner, quotes it with
`psycopg.sql.Identifier`, and commits all table, sequence, and default
privilege grants in one transaction. The exact v5.2.1 backend image does not
contain `psql`, so no undeclared binary dependency was introduced.

## Checks performed

- all 34 local patches apply in sorted order to `UPSTREAM_REF`;
- `ci/test-docs-v5.2.1-performance.py` applies that series in a clean clone,
  builds the local Helm dependency, renders all three Deployments, and asserts
  every startup/readiness/liveness endpoint and threshold;
- the grant heredoc compiles and the test rejects a return to `manage.py shell`
  or an unavailable `psql` dependency;
- `manage.py migrate --check` reports no unapplied migration;
- the app database role completed create/read/update/delete;
- a database owned by a role named `Docs benchmark owner` received all grants,
  including identifier quoting, sequence privileges, and default privileges
  on a table created after the grant transaction;
- authenticated owner list/open returned 200 while the no-access user received
  403;
- private MinIO put/get/delete succeeded and anonymous GET returned 403;
- two browsers exchanged a live edit while the WebSocket stayed open;
- the 60-second save assertion confirmed the edit was written through the
  document content endpoint.

Re-run the deterministic patch/chart checks with:

```bash
python3 ci/test-docs-v5.2.1-performance.py \
  --infra-source /path/to/mijn-bureau-infra
```

## Risks and bottlenecks not changed

- Faster readiness allows traffic as soon as the existing endpoint succeeds.
  Four-worker startup and lazy per-worker state still create first-request
  variance; the full browser benchmark succeeded in every measured sample.
- Readiness now checks once per second instead of once per 10 seconds. The
  endpoints are intentionally lightweight, but this is a small permanent
  health-check traffic increase (one request/second per pod).
- Results are isolated k3d measurements with cached images, not production
  scheduler, registry, node-pressure, TLS, or WAN measurements.
- The four-worker backend still takes 4.66s and about 740MiB. One and two worker
  experiments were not faster (4.93s and 4.83s medians) and would reduce
  request capacity, so worker count is unchanged.
- Celery still takes 5.98s and about 411MiB. `--autoscale=3,1` saved only about
  0.33s and reduced warm capacity, so it is unchanged.
- The y-provider image remains 831MB and its process still takes 2.46s.
- The chart's timestamp-based job release suffix reruns migration/setup jobs on
  every render. Removing that behavior needs a separate lifecycle/idempotency
  design; this PR only makes the required grant setup cheaper.
- Warm document open is still dominated by the object-backed content request,
  WebSocket setup, frontend JavaScript, and editor hydration. No frontend
  bundle or editor behavior is changed here.
