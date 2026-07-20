# Messages fresh-install performance

This benchmark measures a complete, self-signed Open Suite installation on the
standard GitHub-hosted `ubuntu-latest` runner. It does not use a reduced
deployment profile, pre-pull images, bypass migrations, or replace any normal
startup, readiness, or liveness probe.

## Method

Each sample starts on a clean runner and installs the full stack. Kubernetes
pod, container, init-container, and Job transition timestamps are captured
after the normal deploy completes. Phase intervals can overlap and are not
additive. Times below are measured from each resource's creation or start; the
benchmark artifact also retains absolute timestamps, sorted namespace events,
and restart counts.

After infrastructure measurement, pinned Playwright 1.61.1 opens a clean
Chromium context and exercises the real ingress, auth gate, Keycloak login,
Messages silent OIDC login, and Element. The first-use checks require:

- a visible Mail inbox;
- a successful first Matrix `/sync` response;
- a `Secure`, `HttpOnly` Messages session cookie and a session-scoped edge
  authentication cookie; and
- the coordinated logout link to target the auth-gate logout endpoint and
  return to the Open Suite portal.

Small samples are reported as every observation plus median and range; a p95
would imply more precision than three clean-runner samples provide.

## Baseline

The three startup snapshots are from fresh-install runs
[`29772299606`](https://github.com/open-suite/open-suite/actions/runs/29772299606),
[`29773510910`](https://github.com/open-suite/open-suite/actions/runs/29773510910),
and
[`29775354714`](https://github.com/open-suite/open-suite/actions/runs/29775354714).
The app manifests and images were identical. Each run retained a complete
Messages pod/Job snapshot before a benchmark-only observation failed, so those
failures do not alter or truncate the Kubernetes startup intervals below.

| phase | observations | median | range |
|---|---:|---:|---:|
| PostgreSQL pod to Ready | 51s, 24s, 50s | 50s | 24–51s |
| database stability init container | 225s, 157s, 149s | 157s | 149–225s |
| Django migration execution | 33s, 156s, 29s | 33s | 29–156s |
| migration pod to durable Job completion | 361s, 411s, 261s | 361s | 261–411s |
| backend pod to Ready | 348s, 416s, 260s | 348s | 260–416s |
| frontend pod to Ready | 275s, 372s, 75s | 275s | 75–372s |
| OpenSearch pod to Ready | 408s, 439s, 273s | **408s** | 273–439s |

OpenSearch was the longest phase in every sample and restarted **2, 2, and 1**
times. Its existing liveness check starts during cold initialization and kills
the process after three failed checks. Under full-stack CPU and I/O contention,
that repeated a one-gigabyte image's JVM initialization before the node could
answer its cluster-health endpoint. Backend and migration timings varied with
the same host contention, but neither was the critical path.

## Optimization and preserved contracts

The only application change adds an OpenSearch `startupProbe` against the same
`/_cluster/health` endpoint used by readiness. It has a 10-minute bounded
budget, a 10-second period, and a 5-second HTTP timeout. Until it succeeds,
Kubernetes does not apply liveness to a valid cold start. After it succeeds,
the existing readiness and liveness checks are unchanged.

The PostgreSQL startup probe, six-success/30-second database stability rule,
separate retrying migration Job, migration command, backend database heartbeat,
session-cookie attributes, and coordinated logout contract are unchanged and
remain CI assertions.

The tradeoff is explicit: a permanently broken OpenSearch startup can take up
to 10 minutes to be restarted instead of roughly 100 seconds. This is bounded
inside the existing 20-minute install wait and avoids restarting a progressing
cold start on the minimum supported host.
