# Messages fresh-install performance and reliability

This benchmark measures a complete, self-signed Open Suite installation on the
standard GitHub-hosted `ubuntu-latest` runner. It does not use a reduced
deployment profile, pre-pull images, bypass migrations, or replace any normal
startup, readiness, or liveness probe. The measured change below is a cold-start
reliability improvement, not a demonstrated latency optimization.

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

- a successful authenticated Mail thread-list response followed by an
  app-rendered empty-mailbox or thread-panel state;
- a successful first Matrix `/sync` response;
- `Secure`, `HttpOnly` Messages and edge-gate cookies, with the edge cookie
  scoped to the browser session; and
- the coordinated logout link to target the auth-gate logout endpoint and
  finish at Keycloak's login form after the protected portal redirect, with
  both cookies removed. Requiring authentication again is the expected
  fail-closed result after logout.

The browser makes one attempt and uses API and application-owned DOM signals;
there are no retries or CI workarounds that can hide a failed OIDC exchange,
mailbox provision, Matrix sync, or logout.

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

## After the OpenSearch startup probe

The three comparable clean-runner samples are from fresh-install runs
[`29777255419`](https://github.com/open-suite/open-suite/actions/runs/29777255419),
[`29778406874`](https://github.com/open-suite/open-suite/actions/runs/29778406874),
and
[`29779631686`](https://github.com/open-suite/open-suite/actions/runs/29779631686).

| phase | observations | median | range |
|---|---:|---:|---:|
| PostgreSQL pod to Ready | 34s, 36s, 30s | 34s | 30–36s |
| database stability init container | 120s, 152s, 319s | 152s | 120–319s |
| Django migration execution | 188s, 59s, 14s | 59s | 14–188s |
| migration pod to durable Job completion | 421s, 297s, 409s | 409s | 297–421s |
| backend pod to Ready | 426s, 301s, 405s | 405s | 301–426s |
| frontend pod to Ready | 159s, 150s, 337s | 159s | 150–337s |
| OpenSearch pod to Ready | 434s, 311s, 424s | **424s** | 311–434s |

OpenSearch remained the longest phase in every sample. Its restart count fell
from **1–2 per sample to zero in all three samples**, but median OpenSearch Ready
latency changed from **408s to 424s**. That 16-second regression is within the
large runner-contention spread and provides no evidence of a speedup. The
startup probe is therefore justified only as restart elimination and more
predictable initialization.

## Correctness changes and preserved contracts

The OpenSearch change adds a `startupProbe` against the same
`/_cluster/health` endpoint used by readiness. It has a 10-minute bounded
budget, a 10-second period, and a 5-second HTTP timeout. Until it succeeds,
Kubernetes does not apply liveness to a valid cold start. After it succeeds,
the existing readiness and liveness checks are unchanged.

The Messages namespace has a default egress whitelist. A separate rule now
selects only Messages backend pods and permits TCP 8080 only to Keycloak pods in
the configured Keycloak namespace. This is required for the OIDC code/token
exchange and Keycloak mailbox/group provisioning; it is a correctness and
security fix, not a performance claim. Fresh-install run
[`29781044007`](https://github.com/open-suite/open-suite/actions/runs/29781044007)
reached the authenticated mailbox URL and returned successful mailbox/thread
API responses, providing an end-to-end check of that backchannel rule. That run
then failed on the benchmark's old English `Inbox` text selector, which the
locale-independent API/render signal above replaces.

The PostgreSQL startup probe, six-success/30-second database stability rule,
separate retrying migration Job, migration command, backend database heartbeat,
session-cookie attributes, and coordinated logout contract are unchanged and
remain CI assertions.

The tradeoff is explicit: a permanently broken OpenSearch startup can take up
to 10 minutes to be restarted instead of roughly 100 seconds. This is bounded
inside the existing 20-minute install wait and avoids restarting a progressing
cold start on the minimum supported host.

## First-use acceptance

Historical samples establish the infrastructure distributions above but do not
claim a completed authenticated first-use measurement: their observation code
failed before producing `first-use.json`. The acceptance run for the final
pushed head must deploy the complete stack twice, pass Helmfile convergence,
and record Mail usability, first Matrix sync, both secure-cookie checks, and
actual coordinated logout. Its exact timings and run link belong in the PR
results rather than being inferred from the infrastructure milestones.
