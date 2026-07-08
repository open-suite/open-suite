# Open Suite performance notes

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

### Patch 2: static asset cache headers in the Open Suite sidecar

Updated `scripts/single-vps-deploy/09-portal-header.sh` so the sidecar used for
Nextcloud, Docs, Grist, and the portal sends immutable browser cache headers for
static assets while keeping HTML uncached and header-injected.

Why this is the right first change:

- It avoids changing upstream application source.
- It improves repeat navigation and reloads for heavy SPAs.
- It leaves the HTML route as the single supported route and only changes asset
  cache policy.

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

The caldav endpoint stays slow, but not for the reason first assumed. Measured
2026-07-08:

- A single CalDAV request with basic auth (an app password) from the portal pod
  to Nextcloud is ~5ms, whether through the public gated ingress or the
  in-cluster service. So neither the auth gate hop nor network is the cost.
- The portal uses a bearer token (the exchanged nextcloud-audience token). On a
  bearer request Nextcloud's user_oidc (`provider-1-checkBearer=1`) validates it
  and, on that path, tries to reach the provider — but `id.<domain>` resolves via
  the CoreDNS split-horizon rewrite to the in-cluster Keycloak ClusterIP and the
  fetch throws `LocalServerException: Host "…" (id.<domain>:80) violates local
  access rules` (seen repeatedly in nextcloud.log) despite
  `allow_local_remote_servers=true`. Each CalDAV request (principal + calendars
  + one search per calendar, ~4 for johndoe) eats that stall, ~3s total.

The real fix is Nextcloud reaching Keycloak's discovery/JWKS over a working
in-cluster backchannel (the KC_BACKCHANNEL pattern the other apps use for OIDC),
not the portal. Login-critical, so it needs its own change + verification —
tracked as a follow-up, not bundled with the token-exchange cache.
