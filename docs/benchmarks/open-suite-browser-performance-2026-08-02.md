# Open Suite browser performance baseline

Date: 2026-08-02

Environment: live demo at `*.demo.opensuite.online`

## Executive summary

Open Suite currently scores **59/100** for browser performance and perceived
responsiveness. This is an equal-weight average of the seven user-facing
product audits plus the cross-suite SSO audit, all using the same rubric.

The suite does not feel slow because the VPS lacks capacity. During the audit,
the node used 8–19% CPU, 19–21% memory and 23% disk. PostgreSQL and Redis were
lightly loaded. The dominant costs are repeated authentication/application
bootstrap, frontend payload and initialization, full-page app transitions,
blank or spinner-only intermediate states, and application-specific request
waterfalls.

The previous infrastructure and pod-startup improvements are real, but they do
not directly reduce most of the delays a signed-in user sees. They improved
capacity, readiness and cold pod behavior; this baseline measures browser and
journey readiness on already-running production applications.

| Surface | Score | Most important measured problem |
| --- | ---: | --- |
| Portal | **70** | Cross-app readiness: Mail 5.60s, Calendar 6.94s, Chat 12.04s |
| Meet | **69** | Cold SSO 7.22s; create-to-joined 1.87s with a white transition |
| Grist | **62** | Cold LCP 3.53s; create-to-grid 3.59s; large startup chunks |
| Cross-suite SSO | **59** | Possible immediate post-login navigation race; Nextcloud warm readiness 10.29s |
| La Suite Docs | **58** | Existing document ready 3.57s; double bootstrap; title PATCH returns 500 |
| Element | **54** | Fresh sign-in to stable UI 12.62s; cold room list 5.71s |
| Nextcloud | **52** | Cold Files 8.18s; 5.26MB JS; warm main-thread work remains high |
| Collabora | **45** | File action to editable 8.05s cold / 5.61s warm |
| **Suite average** | **59** | |

There is not yet evidence to justify broad, permanently maintained forks of
Nextcloud, Meet, Grist, Element or Collabora. The first work should be shared
auth instrumentation, caching/configuration, visual transition patches,
enabled-app reduction, and narrowly upstreamable frontend changes. Reconsider
a fork only after traces isolate an upstream code path, a small upstream patch
is rejected, and a repeatable benchmark proves the gain.

## Test design and score

Eight isolated Amp orbs each owned one audit. They used real Chromium through
Playwright and the Chrome DevTools Protocol because Chrome DevTools MCP was not
available inside the orbs. Audits used the demo account from secret environment
variables, did not retain credentials or tokens, and removed owned test data.
Each product generally had three cold and three warm measurements, plus
representative interactions and short-interval visual capture where privacy
allowed.

The common 100-point rubric was:

| Category | Weight |
| --- | ---: |
| Load and render | 25 |
| Responsiveness | 20 |
| Visual stability and flashes | 20 |
| Network, JavaScript and CSS | 15 |
| Backend and API | 10 |
| Perceived UX | 10 |

The internal responsiveness target is **100ms** for visible acknowledgement.
More than 200ms is treated as clearly noticeable, and more than one second as
a flow interruption. This is deliberately stricter than using Core Web Vitals
alone. CLS can be zero while a page still feels poor because a blank screen,
generic skeleton or spinner is replaced wholesale by the real application.

This is a synthetic baseline, not field RUM. It represents one orb network,
desktop viewport, unthrottled connection and small sample. It is suitable for
finding sequencing problems and establishing repeatable regression budgets,
not claiming global p95 latency.

## Cross-suite findings

### 1. The server is not saturated

| Resource | Observed state | Conclusion |
| --- | --- | --- |
| Node CPU | 8–19% across seven samples | Large headroom |
| Node memory | 12–14GiB used of 62GiB; about 49GiB available | Large headroom |
| Swap | 34MiB used of 31GiB | No meaningful swapping |
| Disk | 93GiB used of 436GiB; short samples generally 5–14% utilization | Not constrained |
| Network | Zero physical-interface errors or drops | Not constrained |
| PostgreSQL | 9–74MiB app databases; 99.98–100% cache hit; no deadlocks/temp spills/queries over 1s | No demonstrated DB bottleneck |
| Redis | 0.8–9MiB used; no evictions or rejected connections | No demonstrated Redis bottleneck |

A host upgrade is unlikely to materially improve the present experience.
Faster cores might shave some uncached PHP/JVM work, but they will not remove
SSO round trips, frontend initialization or blank transition states.

One real resource defect was found: kernel logs recorded Nextcloud PHP
memory-cgroup OOM kills on 2026-08-01 and 2026-08-02. The host had ample free
RAM, so this is a CronJob/container limit problem, not a reason to buy more host
memory.

### 2. The common network/auth floor is visible

Unauthenticated protected app requests from the infrastructure audit had
roughly 630–680ms TTFB, including about 430–470ms to complete TLS. Direct
Keycloak TTFB was around 337–346ms. Browser product audits commonly saw a
roughly 160–180ms warm dynamic-request floor after connection reuse.

The cold paths frequently establish two layers of session state: the shared
edge/auth-gate session and the application's own OIDC session. Docs visibly
boots the complete application, receives `users/me` 401, starts application
OIDC, then boots again. Meet similarly performs an avoidable pre-auth user
probe. The portal cold flow regresses from full navigation to a logo-only shell
while sessions converge.

The SSO audit found 15/15 warm launches successful, but only 3/15 cold launches
passed when navigation was issued immediately after the first portal app link
appeared. Eleven app navigations were aborted and returned to the bridge. The
harness used the discovered destination directly rather than dispatching the
real tile click, so this is a **P0 candidate**, not yet a confirmed blocker.
Repeat with actual tile clicks at 0s, 1s and 3s after dashboard readiness.

### 3. Warm caches remove bytes, not initialization

Several applications transfer almost nothing on warm reload but remain slow:

| App | Warm transfer/cache evidence | Warm useful state |
| --- | --- | ---: |
| Portal | 15KB median, 20 disk-cache hits | Dashboard 1.17s |
| Meet | 1.7KB resources; 0B JS/CSS | Usable 1.15s |
| Docs | 11–13KB; 19/24 resources cached | List 0.72s |
| Element | 14.9KB median | Room list 2.24s |
| Nextcloud Files | 60KB; 178/184 cached | Usable 1.42s, 0.86s long-task total |
| Collabora frame | 65.7KB; 87/92 cached | File action to editable 5.61s |

This is why CDN or server-size changes alone will not make the suite feel
instant. Cached JavaScript still parses and initializes, app providers still
register, APIs still fan out, and document/collaboration state still connects.

### 4. Perceived performance is worse than numeric stability

Most measured CLS values are good, yet several applications visibly show
blank, spinner-only or structurally wrong intermediate states:

- Portal: generic four-card skeleton abruptly becomes the real multi-size
  dashboard; cold OIDC briefly removes the full header.
- Meet: a plain white frame appears during the 1.87s room join.
- Docs: blank body with a centered spinner for more than 1.25s; raw Material
  icon ligatures flash while opening a document.
- Nextcloud: branded shell, then blank/spinner, then the list; MIME placeholders
  fill later. Calendar hydrates shell, sidebar and events in waves.
- Element: white page, then branded header with blank body, then spinner, then
  content. Fresh first use is still spinner-only at 8s.
- Collabora: Files remains visible with a spinner, then a blank white viewer and
  spinner; loading is still visible at 4s even when warm.
- Grist is the positive exception: branded splash and themed shell remain
  stable, with excellent CLS and no observed wrong-brand flash.

## Product reports

### Portal — 70/100

Source audit: [portal orb](https://ampcode.com/threads/T-019fc170-c664-748f-83a6-55c6d62c109e)

| Metric | Median/result |
| --- | ---: |
| Cold SSO to dashboard | 6.20s |
| Warm dashboard | 1.17s |
| Warm TTFB / FCP / LCP | 162ms / 204ms / 1.58s |
| In-page interactions | 58–95ms |
| Projects API | 880ms |
| Activities API | 670ms |
| Messages widget API | 378ms |
| Portal click to usable Mail / Calendar / Chat | 5.60s / 6.94s / 12.04s |

The portal itself is responsive after load. No measured in-page interaction
exceeded 100ms, caching is strong, and CLS was zero. The poor feeling comes
from shell reconstruction, widget completion in waves and destination apps.

Priorities:

1. Make the bootstrap skeleton reserve the final dashboard geometry and keep
   the header stable throughout OIDC.
2. Bound-parallelize OCS project-stack reads and add short per-user
   single-flight caching for read-only Projects/Activities responses.
3. Add app-origin preconnect and trace portal-click through destination usable
   state.
4. Replace expected bootstrap 401 console noise and the disconnected Chat
   widget with intentional auth/loading states.

Fork judgment: no additional fork. The owned portal fork can take narrow
changes in loading geometry, auth bootstrap and OCS clients.

### Meet — 69/100

Source audit and evidence: [Meet orb](https://ampcode.com/threads/T-019fc170-d48f-74fc-aca0-7e2b44e1e0b8)

| Metric | Median/result |
| --- | ---: |
| Cold SSO to usable | 7.22s |
| Hot-cache usable | 1.15s |
| Hot TTFB / LCP | 163ms / 332ms |
| Create and join room | 1.87s |
| Room API / LiveKit WS handshake | 227ms / 171ms |
| Initial authenticated JS/CSS | about 860KB |
| Cache-seed critical asset tail | 2.2–4.4s |

Meet has excellent visual stability once settled: CLS was zero and no long
task was observed. The main problems are the cold auth path, critical asset
delivery, an unnecessary pre-auth `users/me` 401, and the white room-join
transition.

Priorities:

1. Gate user queries on auth readiness and instrument every redirect phase.
2. Render a branded joining state immediately; overlap route transition,
   media acquisition and LiveKit connect where safe.
3. Bundle-analyze the large primitives/room chunks and lazy-load LiveKit,
   settings and room-only code after home readiness.
4. Verify TLS resumption, HTTP/2 reuse, compression and immutable caching.

Fork judgment: do not fork. These are configuration changes or narrowly
upstreamable query-gating/code-splitting/join-sequencing changes.

### Grist — 62/100

Source audit and evidence: [Grist orb](https://ampcode.com/threads/T-019fc170-e56d-75b9-830b-1d73a9a59c36)

| Metric | Median/result |
| --- | ---: |
| Cold TTFB / FCP / LCP | 707ms / 2.36s / 3.53s |
| Warm TTFB / LCP | 183ms / 2.69s |
| SSO submit to usable home | 3.78s |
| Create to grid / reopen to grid | 3.59s / 3.35s |
| Menu / edit visible / vertical scroll / horizontal scroll | 137ms / 100ms / 77ms / 40ms |
| Main bundle | 547KB transfer / 1.78MB decoded |

Grist is visually the best-behaved product in the suite. It preserves a
branded splash and themed shell, has essentially zero CLS, and showed no
errors or failed requests. Its weakness is startup and document-route weight,
not interaction handling.

Priorities:

1. Set valid build/version metadata instead of `/v/unknown/` so immutable
   caching and diagnostics are trustworthy.
2. Lazy-load the nonessential 279KB YouTube promo image.
3. Establish bundle budgets and defer document/settings/history/automation
   chunks that are not required for the first grid.
4. Add Server-Timing and RUM route/grid-ready marks.

Fork judgment: no fork; configuration, upstream bundle work and observability
come first.

### La Suite Docs — 58/100

Source audit and evidence: [Docs orb](https://ampcode.com/threads/T-019fc170-db3e-72b8-8408-c7ebaf7c008e)

| Metric | Median/result |
| --- | ---: |
| Full SSO to list | 6.36s |
| Cold / warm list | 2.59s / 719ms |
| Existing document editor ready | 3.57s |
| Create to editor | 1.84s |
| Collaboration WebSocket observed | 2.77s |
| Remote edit visible | 307ms |
| Menu / local typing batch | 83ms / 95ms |
| JS | 1.03MB encoded / 3.44MB decoded |

The audit found a correctness defect: title `PATCH` after creating a document
returned HTTP 500 in two independent flows while optimistic UI retained the
new title. This must be fixed before interpreting the create flow as healthy.

Priorities:

1. Retrieve the backend traceback and add a POST→immediate-title-PATCH
   regression test. Likely areas are update serialization annotations or an
   uncaught collaboration transport exception; do not guess without traceback.
2. Eliminate the edge-session → full Docs boot → `users/me` 401 → app OIDC →
   second full boot sequence.
3. Start the collaboration provider as soon as document identity is known and
   overlap independent tree/access/thread requests.
4. Add immutable caching for fingerprinted Next assets and preload or replace
   above-the-fold ligature icons.
5. Render a stable list/editor skeleton instead of spinner-only and raw-icon
   intermediate states.

Fork judgment: a narrow upstream/source patch is justified for the 500 once
the traceback identifies application behavior. Deployment/auth/cache fixes do
not require a broad fork.

### Element — 54/100

Source audit and evidence: [Element orb](https://ampcode.com/threads/T-019fc170-ec56-7098-bc19-5a0120f6332d)

| Metric | Median/result |
| --- | ---: |
| Fresh Sign In to stable UI | 12.62s |
| Cold room list / LCP | 5.71s / 5.70s |
| Warm room list / LCP | 2.24s / 2.22s |
| Initial `/sync` | 185ms, 46.7KB |
| Cold payload | 4.32MB: 2.12MB JS + 1.88MB crypto WASM |
| Cold CORS preflights | 18 |
| Room / settings completion | 231ms / 335ms |
| Event Timing maximum | 88ms |

Synapse initial sync is not the multi-second bottleneck. Client startup,
crypto initialization, optional capability probes and React mounting dominate.
The first-run notification toast physically overlaps room search and blocked a
normal pointer click for the 30s automation timeout.

Priorities:

1. Add bounded `Access-Control-Max-Age` without broadening allowed origins,
   headers or methods.
2. Move/delay the notification prompt so it never covers room controls.
3. Add immutable caching for content-hashed bundles.
4. Render cached/useful shell state before optional TURN/RTC/Jitsi/device/key
   backup probes; measure Rust crypto/store phases before safely deferring any
   crypto work.
5. Remove duplicate capability/version/history probes where SDK lifecycle
   permits.

Fork judgment: no broad fork. CORS, caching and toast placement are downstream
work. A narrow source fork is defensible only if upstream rejects a tested
progressive-startup implementation that preserves encrypted-room correctness.

### Nextcloud Files and Calendar — 52/100

Source audit and evidence: [Nextcloud orb](https://ampcode.com/threads/T-019fc170-ce0f-7001-a7c6-edb8a486f0bc)

| Metric | Median/result |
| --- | ---: |
| Cold SSO to usable Files | 8.18s |
| Cold TTFB / FCP / LCP | 2.41s / 4.70s / 7.52s |
| Cold Files payload | 185 requests / 5.57MB; 110 scripts / 5.26MB |
| Warm Files usable / long tasks | 1.42s / 862ms total |
| Calendar cold-specific / warm usable | 2.10s / 1.23s |
| File action menu | 229ms cold / 316ms warm |
| Calendar week view / return to Files | 1.31–1.42s / 1.41–2.06s |
| Files / Calendar DAV header wait | about 233–236ms / 218–226ms |

Nextcloud has the largest eager frontend fan-out. Core Files loads optional PDF
viewer, Calendar contacts, Richdocuments, Draw.io, unified search, sharing and
other registrations. Warm byte caching works extremely well, but evaluation,
provider initialization, rendering and DAV remain.

Priorities:

1. Audit enabled apps and disable anything not used by this distribution.
2. Lazy-load optional file action/reference/viewer integrations; profile menu
   provider startup so core actions appear immediately.
3. Instrument PHP-FPM queue/worker/OPcache and fix the observed cron container
   OOM limit.
4. Preserve a branded destination shell and explicit data readiness during
   Files/Calendar full-page transitions.
5. Reduce Calendar visible-range DAV fan-out and generate/persist demo
   previews.
6. Add auth-to-PHP Server-Timing before tuning PostgreSQL, Redis or object
   storage; current evidence does not blame them.

Fork judgment: do not begin with a broad Nextcloud fork. Configuration and
enabled-app reduction come first. A narrow upstream-oriented fork may later be
worthwhile for proven eager app registration/action-provider behavior.

### Collabora through Nextcloud — 45/100

Source audit and evidence: [Collabora orb](https://ampcode.com/threads/T-019fc170-f357-76ad-872e-33a2e7315a86)

| Metric | Median/result |
| --- | ---: |
| Enter Files to list usable | 6.60s cold / 2.64s warm |
| File action to Collabora frame | 4.83s cold / 3.89s warm |
| Frame to editor controls | 3.16s cold / 1.75s warm |
| File action to editable | 8.05s cold / 5.61s warm |
| Cold / warm frame LCP | 3.40s / 1.38s |
| Largest long task | 1.05s cold / 248–259ms warm |
| First glyph | 201–238ms |
| Save acknowledgement | 172–178ms; Collabora internal work 7–9ms |
| Frame CLS | 0.101 cold / 0.127 warm |

All six documents opened, edited and saved successfully. The WOPI and
WebSocket path is functional. The delay splits between Nextcloud Files and
richdocuments setup, then Collabora parse/render. The File menu focused but did
not visibly open in all six headless captures; confirm once in headed Chrome
before treating it as a release blocker.

Priorities:

1. Add phase marks for file action, richdocuments import, token, iframe,
   WebSocket, first tile and editable state; correlate CheckFileInfo/GetFile/
   PutFile server spans.
2. CPU-profile the deterministic 1.048s Collabora task and upstream one narrow
   lazy-initialization change.
3. Confirm and fix the SmartMenus lifecycle/z-index/overflow problem; add a
   smoke assertion that a menu item becomes visible.
4. Trace the 221–234ms richdocuments token endpoint without weakening WOPI.
5. Reserve final editor geometry, restore the missing icon, deduplicate viewer
   registration and fix the blocked inline script with a nonce/hash or external
   file—not `unsafe-inline`.

Fork judgment: no fork before phase tracing and a CPU profile. Extend the
existing narrow SmartMenus patch only if headed reproduction confirms it.

### Cross-suite SSO — 59/100

Source audit and evidence: [SSO orb](https://ampcode.com/threads/T-019fc170-fa27-741c-a9c1-87cf617bfdf7)

Thirty journeys covered five apps × three cold and three warm launches.

| App | Warm success | Warm readiness median |
| --- | ---: | ---: |
| Meet | 3/3 | 4.29s |
| Element | 3/3 | 4.47s |
| Docs | 3/3 | 4.51s |
| Grist | 3/3 | 5.67s |
| Nextcloud | 3/3 | 10.29s |

Keycloak branding appeared immediately and its document TTFB was around
160ms. The cold 3/15 result is a controlled-race candidate with an important
harness qualification, described above. Logout coherence was inconclusive.

Priorities:

1. Repeat with real tile clicks at 0/1/3s and privacy-safe server request IDs.
2. If reproduced, stop portal post-login lifecycle work from replacing an
   already-issued user navigation and route launches through one documented
   handoff.
3. Add a bounded “Signing you in…” state, retry around 10s and actionable error
   before 30s rather than silently returning to bridge.
4. Implement standards-compliant RP-initiated logout that clears auth-gate
   state and verify every app prompts again.

Fork judgment: no Keycloak or app fork based on this audit. Shared auth-gate,
portal lifecycle and declarative client/logout configuration are the likely
owners.

## Prioritized suite plan

### P0 candidates and correctness

- Reproduce the immediate post-login tile race using real clicks before making
  it a blocker.
- Fix Docs title PATCH 500 and add a regression test.
- Confirm the Collabora File menu in headed Chrome; fix if reproduced.

### P1: instrument the actual critical path

- Add privacy-safe request IDs and `Server-Timing` at Traefik/auth-gate/app
  boundaries.
- Add OpenTelemetry spans around app request handling, PostgreSQL, Redis,
  object storage, WOPI and collaboration providers.
- Enable `pg_stat_statements` declaratively.
- Add RUM for TTFB, FCP, LCP, INP, app-ready and route-ready markers.
- Persist alerts for cgroup OOMs, failed CronJobs, HPA changes and pod startup.

### P1: eliminate shared perceived-performance defects

- Keep a stable branded shell across auth and full-page app navigation.
- Replace generic/global spinners with destination-shaped skeletons and phase-
  appropriate progress.
- Never regress from a complete header to a logo-only or blank state.
- Give every user action visible acknowledgement within 100ms even when the
  operation continues asynchronously.

### P1/P2: reduce startup work

- Audit enabled Nextcloud apps and defer optional registrations.
- Add immutable cache headers for fingerprinted assets in Docs, Element,
  Grist, Collabora and any Nextcloud routes that lack them.
- Add CORS preflight max-age for Matrix.
- Establish bundle budgets and route-level lazy loading for Meet, Docs, Grist
  and Element.
- Keep one or two warm replicas during demo hours only where process startup or
  scale-from-one is proven to affect users.

### P2: backend and infrastructure

- Fix Nextcloud cron memory limits.
- Measure PHP-FPM worker queue and OPcache before changing replicas.
- Correct HPA requests so percentages represent real saturation.
- Keep auth-gate warm and instrument its duration/error rate.
- Do not move PostgreSQL, Redis or MinIO to separate hardware without measured
  pressure; current data shows substantial headroom.

## Regression budgets

The next baseline should enforce these targets:

| Measure | Interim target | Long-term target |
| --- | ---: | ---: |
| Suite score | ≥70 | ≥85 |
| Warm portal/dashboard or app list ready | <1.5s | <1.0s |
| Authenticated portal click to useful destination | <3.0s | <1.0s |
| Full cold sign-in to first useful app | <6.0s | <4.0s |
| Visible interaction acknowledgement | <100ms | <100ms |
| Async control completion | <200ms where local; explicit progress otherwise | <200ms |
| Main-thread long task | none >200ms | none >100ms |
| Spinner without contextual progress | <1.0s | <500ms |
| Wrong/default/unbranded flash | 0 | 0 |
| CLS | <0.1 | <0.05 |
| Fingerprinted static assets | immutable caching verified | immutable caching verified |
| Nextcloud cold Files | <4MB and <140 requests | <2.5MB and <100 requests |
| Nextcloud warm Files | <1.0s usable | <750ms usable |
| Collabora warm file action to editable | <4.0s | <2.0s |
| Element warm room list | <1.5s | <1.0s |

Re-run the same audits after each performance milestone and at least monthly on
the live demo. Preserve raw sanitized metrics, browser version, deployment
commit/image digests, region and score rubric so scores remain comparable.

## What not to do yet

- Do not upgrade the host as the primary performance intervention.
- Do not create broad product forks before tracing and targeted patches.
- Do not add a CDN and declare victory: warm cached paths are still slow.
- Do not relax CSP, WOPI validation, CORS origins or authentication to improve
  timings.
- Do not hide real waits with arbitrary delays or optimistic success states.
- Do not aggregate every portal widget behind one blocking endpoint.

## Audit threads

- [Portal](https://ampcode.com/threads/T-019fc170-c664-748f-83a6-55c6d62c109e)
- [Nextcloud](https://ampcode.com/threads/T-019fc170-ce0f-7001-a7c6-edb8a486f0bc)
- [Meet](https://ampcode.com/threads/T-019fc170-d48f-74fc-aca0-7e2b44e1e0b8)
- [Docs](https://ampcode.com/threads/T-019fc170-db3e-72b8-8408-c7ebaf7c008e)
- [Grist](https://ampcode.com/threads/T-019fc170-e56d-75b9-830b-1d73a9a59c36)
- [Element](https://ampcode.com/threads/T-019fc170-ec56-7098-bc19-5a0120f6332d)
- [Collabora](https://ampcode.com/threads/T-019fc170-f357-76ad-872e-33a2e7315a86)
- [SSO](https://ampcode.com/threads/T-019fc170-fa27-741c-a9c1-87cf617bfdf7)
