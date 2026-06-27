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

### Live deployment verification

Deployed to `demo.opensuite.online` on 2026-06-27.

Verified after rollout:

- Nextcloud deployment is available with two containers:
  - `opensuite-header`
  - `nextcloud`
- Runtime PHP settings now show:
  - `apc.shm_size = 128M`
  - `opcache.enable = On`
  - `opcache.enable_cli = On`
  - `opcache.memory_consumption = 256`
  - `opcache.interned_strings_buffer = 32`
  - `opcache.max_accelerated_files = 50000`
  - `opcache.validate_timestamps = Off`
- Static assets through the Nextcloud sidecar now return:
  - `Cache-Control: public, max-age=31536000, immutable`

If this is still visibly slow, the next clean step is not a fallback and not a
fork: make `/spreadsheets`, `/documents`, `/presentations`, and `/diagrams`
first-party Open Suite pages backed by Nextcloud APIs, then open Collabora or
Nextcloud only when the user opens/creates a file.
