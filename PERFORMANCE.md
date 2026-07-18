# Open Suite performance notes

Current repeatable full-application results and all new measured-improvement
entries belong in [APP-PERFORMANCE-BENCHMARK.md](APP-PERFORMANCE-BENCHMARK.md).
This file preserves earlier investigations, including rejected ideas; do not
copy new benchmark summaries into both ledgers.

## Rule

Open Suite has one supported path for each user action. We do not add fallback
paths for broken behavior. If the supported path is slow or broken, we fix that
path.

## 2026-06-27: Nextcloud cache optimization pass

Goal: improve the existing Nextcloud `/apps/office/` and hard office routes
(`/documents`, `/spreadsheets`, `/presentations`, `/diagrams`) without forking
Nextcloud.

### Live baseline

Checked on `demo.opensuite.online` before this patch:

- Nextcloud pod image: `nextcloud:34.0.0-apache`.
- Redis is already configured for distributed cache and file locking:
  - `memcache.distributed = \OC\Memcache\Redis`
  - `memcache.locking = \OC\Memcache\Redis`
  - Redis host: `nextcloud-redis-headless`
- APCu is already configured for local cache:
  - `memcache.local = \OC\Memcache\APCu`
- Nextcloud cron is already a Kubernetes CronJob every 5 minutes.
- Runtime cache settings before this patch:
  - `apc.shm_size = 32M`
  - `opcache.memory_consumption = 128`
  - `opcache.max_accelerated_files = 10000`
  - `opcache.validate_timestamps = On`

### Patch 1: PHP production cache settings

Added `patches/local/nextcloud-php-cache.patch`, applied to the vendored
MinBZK infra during deploy. It sets chart `phpConfigs` for Nextcloud:

- APCu shared memory: `128M`
- OPcache memory: `256`
- OPcache interned strings buffer: `32`
- OPcache accelerated files: `50000`
- OPcache timestamp validation: `0`
- OPcache revalidation frequency: `0`
- OPcache save comments: `1`

Why this is the right first change:

- It keeps the existing Nextcloud route as the single supported path.
- It is declarative, survives rebuilds, and applies to both the web pod and the
  cron job through the existing chart mechanism.
- It removes per-request PHP file timestamp checks in the immutable container
  runtime.

### Patch 2: static asset cache headers in the Open Suite sidecar (reverted)

The sidecar initially replaced upstream cache policy with a one-year immutable
header for every URL ending in a static extension. The 2026-07-10 distribution
audit removed that override: not every such URL is content-addressed, so the
optimization could retain stale application assets across upgrades. The sidecar
now preserves each application's cache headers and forwards WebSocket/SSE
connections correctly.

Future immutable caching must target only proven content-hashed asset paths and
must be backed by an upgrade test that rejects stale bundles.

### Expected impact

These changes should improve repeat page loads and PHP-rendered requests. They
will not make the first visit to the stock Nextcloud Office SPA sub-100ms,
because that still requires loading and booting the upstream app.

If this is still visibly slow, the next clean step is not a fallback and not a
fork: make `/spreadsheets`, `/documents`, `/presentations`, and `/diagrams`
first-party Open Suite pages backed by Nextcloud APIs, then open Collabora or
Nextcloud only when the user opens/creates a file.

## 2026-07-08: Portal widget token-exchange cache

### Problem

Every portal widget (calendar, docs, meet, files) minted its downstream token
via a Keycloak token exchange on every request. Measured on the demo, each
widget API call took ~2.4s, dominated by that round trip — a dashboard load
fired several in sequence and felt slow.

### Change

`open-suite-portal` PR #35 (`⚡️(backend) cache exchanged tokens`): the portal
backend caches the exchanged token in-process, keyed by
`(audience, sha256(subject token))`, until a safety margin before the token's
own expiry. A session refresh rotates the subject token and so misses
naturally; caching is per-pod (no shared state); short-lived tokens are never
cached; the cache self-sweeps expired keys. Pinned via PORTAL_REF (#130).

### Measured impact (demo, steady state)

- `/api/v1/docs/documents`: ~2.4s → ~0.13s
- `/api/v1/meet/rooms`: ~2.4s → ~0.14s
- `/api/v1/caldav/calendars/<date>`: ~5s → ~3.1s

The caldav cost is downstream of the portal (the token exchange is cached — 16
hits confirmed in the backend logs). docs/meet make one portal→service round
trip; caldav drives the `caldav` library, which does multiple sequential
requests per load — principal discovery, calendar list, then one REPORT search
per calendar (~4 for johndoe) — against Nextcloud with the exchanged bearer
token.

Baseline measured inside the Nextcloud pod (to localhost:8080, basic auth): a
single calendar PROPFIND is ~220ms — so the caldav-lib flow's ~4 sequential
requests are already ~0.9s before any bearer/OIDC overhead. (A password-grant
token for client `nextcloud` 401s as a bearer, so the portal's exact exchanged
-token path could not be reproduced pod-side; the ~2s gap above that 0.9s is the
unconfirmed bearer/OIDC portion.)

Fixed portal-side (portal #36 / bump #135): cache the discovered calendar URLs
per token so repeat loads skip principal + calendar discovery (~2 of the ~4
requests). Measured on the demo: caldav steady-state ~3.1s → ~1.57s.

The earlier suspicion that user_oidc bearer validation stalls on an unreachable
in-cluster discovery fetch was disproven: the `LocalServerException` log lines
were all from 2026-07-04, before `allow_local_remote_servers` was mounted (#94).
As of 2026-07-08 a discovery fetch from inside the Nextcloud pod returns 200 in
~13ms and recent logs show zero user_oidc errors. So the OIDC backchannel is
healthy and is NOT the cost. The remaining ~1.5s is inherent Nextcloud CalDAV:
two search REPORTs against the PHP CalDAV backend (~220ms base each) plus
per-request bearer signature validation. Reducing it further would mean deeper
Nextcloud work (or fewer calendars queried) — not pursued; caldav is otherwise
healthy and the widget loads in ~1.5s.

## 2026-07-11: Shared-header preconnect experiment (rejected)

The visible shared header was tested with a `<link rel="preconnect">` inserted
only after pointer or keyboard intent toward an app. Ten fresh-context Office
to Documents journeys used an established portal/Keycloak SSO session and a
200 ms hover lead.

Baseline:

- Click to Nextcloud Documents DOMContentLoaded: p75 4,066 ms.
- First Nextcloud connection: p75 116 ms; TLS p75 59 ms.

Candidate:

- Click to target: p75 4,053 ms.
- First connection: p75 117 ms; TLS p75 61 ms.
- The hint existed before every click, but Chrome did not reuse its connection
  for the authenticated navigation. A five-sample `use-credentials` variant
  also retained roughly 109 ms of connection work.

The runtime change was reverted. It did not move the direct connection metric
or page p75 beyond normal variance, and speculative authenticated connections
would add work without demonstrated user benefit. The reproducible journey and
full result history live in the portal repository's
`PERFORMANCE-BENCHMARK.md`.
