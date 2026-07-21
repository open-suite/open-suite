# Grist startup and first-use benchmark

This benchmark owns the Grist-specific performance contract. It deliberately
does not change shared resource sizing or the shared application harness.

## Accepted change: remove the redundant RestartShell

The chart previously combined tag `1.7.15` with digest
`sha256:d9d35c82799bfa2e0438bb60385fb0b550465dabde2a6e0ceca8afec1aae3305`.
The digest wins when Kubernetes resolves the image, and that digest contains
Grist 1.6.1, where `GRIST_RESTART_SHELL` is ignored. The patch now pins the
effective rendered image to the Grist 1.7.15 index digest
`sha256:0263064906e2fa88063129d1b84a6ae3d33acb090062e510b32f87b7a1c84917`.
The rendered-manifest regression guard fails unless the Grist Deployment uses
that exact image.

Grist 1.7.15 defaults `GRIST_RESTART_SHELL` on for Linux. The first Node
process binds the port and forks a second copy of the server so an admin-panel
restart can replace the child without releasing the socket. Kubernetes already
owns restart supervision and readiness for this deployment; the shell is not a
crash supervisor. Setting `GRIST_RESTART_SHELL=false` starts the application
directly and removes one process/startup layer.

Direct-server `/status` becomes live before Grist's internal ready flag. The
patch therefore keeps liveness on `/status`, changes readiness to
`/status?ready=1`, and polls it every second after the existing five-second
initial delay. A startup probe checks the same ready endpoint after five
seconds, once per second with a one-second timeout, and restarts after 45
failures. This prevents pre-initialization traffic, avoids the old readiness
probe's possible ten-second sampling delay, and bounds initialization at about
50 seconds even when plain `/status` remains healthy. The copied-state upgrade
rehearsal below observed 1.7.15 ready at p95 5.797 seconds, leaving more than
eight times that measured duration before restart.

The larger startup component remains gVisor checkpoint generation (about 5.4s
in log timestamps). It is required to preserve formula isolation and fast
document sandbox restore. Pyodide moved that work out of container startup in a
single exploratory run, but was rejected: Grist recommends gVisor on Linux,
Pyodide changes Python/native-package compatibility, and its per-document
startup and security assurance differ. Persistent or prebuilt gVisor
checkpoints were also rejected because Grist treats them as runtime- and
environment-sensitive and provides no supported cache validation mechanism.

Disabling full TypeORM query logging was tested as another one-pair exploratory
candidate. Fresh-database readiness was 8.49s with logging and 8.65s without;
it was not material in this environment and is not part of the change.

## Accepted measurement

Date: 2026-07-20. Runner: Amp E2B orb, Linux x86-64, 16 logical CPUs, Chromium
140.0.7339.186. Images:

- `gristlabs/grist:1.7.15@sha256:0263064906e2fa88063129d1b84a6ae3d33acb090062e510b32f87b7a1c84917`
- `postgres:17.5-bookworm@sha256:fbcea1bd13b6a882cd6caa6b58db3ae5c102efe50ec625b3e2a5cbc50db5bfe4`

Ten baseline and ten candidate samples were paired with alternating order.
Every sample used a newly created PostgreSQL database, gVisor, the same image,
the same explicit `GRIST_LOG_LEVEL=info`, and `TYPEORM_LOGGING=true` (629 SQL
lines in every profile). The only profile difference was
`GRIST_RESTART_SHELL=false`. The harness waited for HTTP 200 from
`/status?ready=1`, authenticated through Grist's isolated test-login provider,
waited for the blank-document action to become visible, created the database's
first document, and waited for its grid to become usable. It then discarded the
database and container. Test login isolates application latency from an
external IdP; it is not a claim about Keycloak network latency. OIDC
preservation is covered by the pinned source-config regression guard.

Quantiles are linearly interpolated type-7 values. Times are milliseconds.

| Metric/profile | n | min | p25 | p50 | p75 | p95 | max | IQR | MAD |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Container → backend HTTP-ready, baseline | 10 | 7,798 | 7,831 | 7,932.5 | 8,040 | 8,091.4 | 8,095 | 209 | 115 |
| Container → backend HTTP-ready, candidate | 10 | 6,106 | 6,195 | 6,232 | 6,335.25 | 6,403.85 | 6,443 | 140.25 | 79.5 |
| Database initialization, baseline | 10 | 743 | 759.5 | 773.5 | 781.75 | 796.1 | 797 | 22.25 | 12.5 |
| Database initialization, candidate | 10 | 756 | 761.75 | 768.5 | 774.5 | 786.85 | 790 | 12.75 | 7.5 |
| Authenticated home usable, baseline | 10 | 519.73 | 540.03 | 557.32 | 620.90 | 627.13 | 627.52 | 80.88 | 30.65 |
| Authenticated home usable, candidate | 10 | 503.40 | 511.75 | 515.87 | 527.60 | 549.66 | 561.25 | 15.85 | 8.58 |
| First document create + open usable, baseline | 10 | 606.31 | 630.43 | 638.10 | 652.10 | 663.52 | 669.51 | 21.67 | 12.38 |
| First document create + open usable, candidate | 10 | 559.23 | 567.02 | 576.46 | 586.90 | 591.13 | 593.28 | 19.89 | 10.82 |

Median backend readiness improved 7,932.5 → 6,232ms (-1,700.5ms,
−21.44%). Database initialization was unchanged within variance (773.5 →
768.5ms). Post-readiness authenticated-home median improved 557.32 → 515.87ms
(-7.44%), and first-document create/open median improved 638.10 → 576.46ms
(-9.66%). The startup reduction is much larger than either profile's spread;
the smaller browser effects should be reconfirmed after a future deployment.

## 1.6.1 → 1.7.15 upgrade rehearsal

Date: 2026-07-21. The upgrade harness first booted the immutable current
1.6.1 digest, initialized its PostgreSQL home database, authenticated a test
user, and created and opened a real document with a unique marker. After a
graceful stop it made five isolated copies of both the PostgreSQL dump and
`/persist` document state. Each copy then started with the immutable 1.7.15
digest, gVisor, and `GRIST_RESTART_SHELL=false`. The harness required
`/status?ready=1`, unchanged
user/org/workspace/document counts, a strictly increased migration count, and
a usable grid containing the exact marker from the pre-existing document. It
also executes each image's `package.json` version and fails if the immutable
source and candidate digests are not exactly Grist 1.6.1 and 1.7.15.

All five copies migrated from 42 to 51 recorded migrations. Each retained five
users, two organizations, two workspaces, and one document. Times are
milliseconds, with type-7 quantiles.

| Upgrade metric | n | min | p25 | p50 | p75 | p95 | max | IQR | MAD |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Copied 1.6.1 state → 1.7.15 backend ready | 5 | 5,610 | 5,653 | 5,694 | 5,722 | 5,797.2 | 5,816 | 69 | 41 |
| Home DB upgrade/startup setup | 5 | 261 | 262 | 264 | 265 | 267.4 | 268 | 3 | 2 |
| Existing marked document authenticated + open usable | 5 | 1,627.51 | 1,630.78 | 1,633.14 | 1,648.01 | 1,648.46 | 1,648.57 | 17.23 | 5.63 |

This is a representative schema and persisted-document rehearsal, not a copy
of production data or a claim about production dataset scale. It covers the
real version transition that the corrected deployment will perform rather than
only testing a fresh database.

## Reproduce

The benchmark needs Docker, Node 20+, Chromium installed for the pinned
Playwright package, and passwordless `sudo docker`. It never records database
credentials; every run generates a random ephemeral password.

```bash
cd performance
npm ci
npx playwright install chromium
BENCHMARK_SAMPLES=10 \
BENCHMARK_LABEL=grist-restart-shell \
BENCHMARK_RUNNER_LABEL='<stable runner class>' \
BENCHMARK_RUNNER_REGION='<coarse region>' \
BENCHMARK_OUTPUT=/tmp/grist-result.json \
node grist-container-benchmark.mjs
```

Rehearse the effective image upgrade against copied representative 1.6.1 state:

```bash
BENCHMARK_SAMPLES=5 \
BENCHMARK_OUTPUT=/tmp/grist-upgrade-result.json \
node grist-upgrade-benchmark.mjs
```

Raw output stays local. A failed readiness check, missing database markers,
failed page/document readiness, or incomplete sample exits non-zero rather than
silently dropping a run.

Validate the patch against the pinned infra and enforce the durability,
migration, OIDC, sandbox, liveness, and readiness invariants with:

```bash
GRIST_INFRA_DIR=/path/to/clean/mijn-bureau-infra \
  performance/grist-regression-guards.test.sh
```

## Risks and remaining bottlenecks

- Admin-panel changes that request an in-process restart no longer get a
  socket-preserving child replacement; Grist returns 409 and prompts for a
  manual restart. An operator must initiate a Kubernetes rollout, whose
  readiness probe removes the pod from service during restart. Unexpected worker
  crashes already terminated RestartShell, so crash recovery remains
  Kubernetes-owned.
- gVisor checkpoint generation is still the dominant cold-container cost.
  Do not switch to `unsandboxed`, Pyodide, or an unvalidated cached checkpoint
  merely to improve readiness.
- The A/B benchmark uses a fresh PostgreSQL database on every sample. The
  separate upgrade rehearsal copies a representative 1.6.1 database and
  persisted document, but production data volume and cluster storage latency
  may differ. A backup-backed rehearsal remains prudent before production
  rollout.
- The upgrade rehearsal uses Grist's filesystem-backed `/persist` document
  store. Production uses the guarded MinIO topology, so the rehearsal proves
  document-format preservation but not production object-store latency.
- The browser samples use Grist test authentication to control variance. The
  patch does not alter any OIDC setting, and the regression guard fails closed
  if OIDC is disabled, but live Keycloak SSO timing remains a deployment check.
- Full TypeORM SQL logging emits 629 lines in this workload. It was not the
  startup bottleneck on this runner, though a remote or backpressured cluster
  log sink may make it expensive and should be measured separately.
