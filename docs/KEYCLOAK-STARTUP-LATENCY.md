# Keycloak startup and SSO latency

Measured 2026-07-20 for the pinned Open Suite infra revision
`ef1d796211ad8624ad5a78cb9a828b0926c2933b`, after applying the complete
`patches/local` series. The isolated benchmark used the rendered demo realm,
`bitnamilegacy/keycloak:26.3.3-debian-12-r0`,
`bitnamilegacy/keycloak-config-cli:6.4.0-debian-12-r9`, PostgreSQL 17.5, and
the chart's production, HTTP, PostgreSQL, `ispn`/`jdbc-ping`, and realm-import
settings. Images were pre-pulled so registry latency was not counted.

## Result

The material optimization is `keycloak-startup-probes.patch`. Keycloak was
already serving the chart's exact readiness target, `/realms/master`, at a
14.85s median, but the stock chart did not make its first readiness request
until 30s. The patch adds a startup probe with the same 120s failure budget and
checks readiness every 2s from startup. It does not change the readiness target,
disable a probe, or make a failed check pass.

Ten clean, graceful pod-equivalent restarts against a warm database produced:

| Time from container start | n | min | p25 | p50 | p75 | p95 | max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Keycloak serves `/realms/master` | 10 | 14.40s | 14.68s | 14.85s | 14.98s | 15.22s | 15.23s |
| Stock probe reports Ready | 10 | 30.00s | 30.00s | 30.00s | 30.00s | 30.00s | 30.00s |
| Patched probes report Ready | 10 | 16.00s | 16.00s | 16.00s | 16.00s | 16.00s | 16.00s |

This removes 14s (46.7%) from readiness and from the earliest point at which
Helm can run the post-install/post-upgrade config-cli hook. Actual Keycloak JVM
startup and request handling are intentionally unchanged.

## Attribution

The same runs show where actual cold startup is spent:

- Quarkus augmentation: p50 5.03s, p95 5.20s (`n=10`). The stock Bitnami
  image detects the PostgreSQL/build-time configuration and re-augments each
  new container.
- Remaining runtime initialization: about 6.7-7.1s according to Keycloak's
  own `started in` log, plus container entrypoint and measurement overhead.
- PostgreSQL readiness from a new empty container: p50 1.03s, p95 1.40s
  (`n=10`). Database process readiness is not on the critical path once the
  chart dependency is Ready; first-use Keycloak schema creation is separate
  and was 7.4s in the diagnostic first install.
- A forced, ungraceful Keycloak death left a stale JDBC_PING member and made
  the next 12 starts spend about 20s on ten 2s join attempts (HTTP readiness
  p50 35.08s). Graceful shutdown removed all `jgroups_ping` rows. This remains
  the largest crash-recovery tail and is not hidden by the probe change.

`start --optimized` was rejected. The stock image logs approximately five
seconds of augmentation, but `--optimized` is only safe when the exact database
vendor, providers, features, and build-time settings were baked into an
immutable image. Adding the flag to this runtime-built image would make image
upgrades unsafe. Building and owning such an image is outside this PR's scope.

## Realm import

The rendered workload contains the master realm plus the Open Suite realm with
11 clients, nine client-role groups, three users, token-exchange roles, logout
URLs, branding, and the configured session lifetimes.

| config-cli path | n | min | p25 | p50 | p75 | p95 | max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Unchanged input/checksum hit | 10 | 4.10s | 4.21s | 4.37s | 4.46s | 4.73s | 4.74s |
| Forced full reconciliation | 10 | 6.01s | 6.34s | 6.64s | 6.73s | 8.50s | 9.76s |

The hook still runs after every install, upgrade, and rollback. No import file,
managed-resource behavior, checksum behavior, or hook policy changes in this
optimization.

Two config-cli optimizations were measured and rejected:

- `-XX:TieredStopAtLevel=1` and Serial GC did not beat run-to-run spread on
  checksum hits (baseline p50 4.32s; tested variants 4.31-4.55s, `n=8` each).
- `IMPORT_PARALLEL=true` failed the pinned 6.4.0 image with a RESTEasy
  `ClassNotFoundException` while importing clients. It would risk a silently
  incomplete realm and is not enabled.

## OIDC request latency

Immediately after a cold start, one authorization-code login using a rendered
demo user and confidential portal client took 1.90s end to end: 996ms to render
the login page, 506ms to validate credentials and issue the code, and 229ms to
exchange the code. This is diagnostic first-use data (`n=1`), not a distribution
claim.

Twenty subsequent authorization-code flows reused the authenticated SSO
session but used a new state, nonce, code, and token exchange each time:

| Warm operation | n | min | p25 | p50 | p75 | p95 | max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Authorization redirect | 20 | 23.50ms | 26.02ms | 28.05ms | 30.45ms | 36.28ms | 68.72ms |
| Code-to-token exchange | 20 | 14.92ms | 15.65ms | 17.37ms | 19.44ms | 20.78ms | 21.42ms |

The probe-only change cannot alter these request paths. Realm security settings,
access/SSO lifetimes, client secrets, token exchange, front/back-channel logout,
and redirect URI validation are unchanged.

## Methodology and interpretation

- All distributions use type-7 quantiles and report every completed sample.
- Cold runs recreated the Keycloak container from the immutable image and kept
  the already-initialized PostgreSQL database. Containers received `SIGTERM`
  and completed Keycloak shutdown before the next run.
- A 50ms observer measured when the exact readiness URL first returned 200.
  Probe-observed times replayed the rendered schedules: stock first check at
  30s/10s period; candidate startup and readiness checks at 0s/2s period.
- config-cli ran in a new container for every sample. Checksum-hit runs used
  chart defaults; full runs disabled the cache only in the benchmark to force
  the reconciliation path. Errors in logs failed the run.
- OIDC used Authorization Code flow with a clean first login, then an existing
  SSO cookie for warm flows. Every returned code was exchanged and all access,
  refresh, and ID tokens were required. Credentials, cookies, codes, and tokens
  were not retained.
- The isolated 16-vCPU/31GiB orb avoids whole-stack CPU contention and excludes
  image pulls, Kubernetes scheduling, ingress, TLS, and WAN latency. It proves
  the chart gating delay and preserves request-path comparability; it does not
  claim live-demo end-to-end latency.

## Rollout and remaining risk

The startup probe allows 60 failed checks at a 2s period (the same nominal 120s
startup budget as the existing liveness initial delay). Readiness continues to
require the master realm and now detects a later outage in about 6s rather than
about 30s. Probe traffic increases by roughly one inexpensive realm request
every 2s per Keycloak pod. Roll back by removing this patch; no data migration
or realm change is involved.

Remaining bottlenecks, in priority order, are the unsafe-to-skip Quarkus
augmentation, stale JDBC_PING crash recovery, config-cli's 4s JVM floor, and
first-request/JIT work. A future immutable, pre-augmented Keycloak image could
address the first item, but it needs its own image lifecycle and upgrade tests.
