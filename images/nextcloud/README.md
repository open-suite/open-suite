# Open Suite Nextcloud image

Pinned upstream Nextcloud plus:

- `meetcal/` — our Calendar ↔ Meet Nextcloud app (real, lintable source; the
  helm patch only `occ app:enable`s it).
- `user_oidc` at a pinned release with
  `patches/user-oidc-token-exchange-access-token.patch` applied at build time
  (Keycloak 26 standard token exchange rejects
  `requested_token_type=refresh_token`; Meet only needs the access token).
  Upstream PR: (pending — see ticket 3.3).
- `hooks/10-opensuite-apps.sh` — syncs both apps from the image onto the
  `custom_apps` PVC before installation, before upgrades, and immediately
  before Apache starts. This makes post-install setup and required migrations
  see the image's app versions while retaining a same-version restart fallback
  for opcache (`validate_timestamps=0`).

Built and pushed to `ghcr.io/open-suite/nextcloud` by
`.github/workflows/nextcloud-image.yaml` (tags: the upstream base tag, and
`sha-<commit>`); `user_oidc/` is fetched in CI, never committed here.

## Startup performance evidence (2026-07-20)

The dominant Open Suite-specific fresh-start cost was hook ordering. The
upstream entrypoint runs chart `post-installation` hooks before
`before-starting`; consequently the chart downloaded and installed the 19 MiB
`user_oidc` app from the app store before our old hook copied the already-baked
app onto the PVC. The same late ordering meant a core upgrade could run
`occ upgrade` before new baked app code was present.

The image now exposes the one sync script in the upstream entrypoint's
`pre-installation`, `pre-upgrade`, and `before-starting` phases. No migration,
copy, or final pre-Apache sync is removed. Separately, the chart disables PHP
8.4's tracing JIT (`1255`, 8 MiB): measured Nextcloud request bootstrap got
slower from JIT compilation, while 30 warmed authenticated requests showed no
steady-state benefit from leaving it enabled.

### Method

- Baseline source: `cfd2129853f8aac1dc2a69c923928780138f1f96`
  (`main` before this change); base image `nextcloud:34.0.0-apache`, PHP 8.4.22.
- One Docker network with `postgres:17-bookworm` and `redis:8-bookworm`; every
  fresh sample recreated both the Nextcloud volume and PostgreSQL database.
- The mounted PHP files exactly matched `nextcloud-php-cache.patch`. Baseline
  retained the base image's `opcache.jit=1255` / 8 MiB buffer; after samples
  used `opcache.jit=disable` / zero buffer.
- The timed post-install path was the chart-generated bundled-app sequence:
  `occ status`, `occ app:install user_oidc`, `occ app:enable user_oidc`. This
  isolates the path changed here; other chart app-store installs were not
  included.
- Startup time runs from immediately before `docker run` to the first HTTP 200
  from `/status.php`. The first authenticated request is the next request:
  `GET /ocs/v2.php/cloud/user?format=json` with Basic auth and
  `OCS-APIRequest: true`.
- `benchmark-startup.sh` is the repeatable harness. It expects the tested image
  plus the PostgreSQL and Redis images to exist locally; run it as
  `sudo ./benchmark-startup.sh IMAGE on|off 3`. Existing-volume restart
  samples used the same request loop but were collected manually.

### Results

Fresh PostgreSQL installation (three samples; lower is better):

| Measure | Before samples | After samples | Median before → after |
| --- | --- | --- | --- |
| Start to `/status.php` | 23,854 / 25,401 / 23,022 ms | 17,728 / 18,163 / 17,706 ms | 23,854 → 17,728 ms (**-25.7%**) |
| Bundled `user_oidc` post-install path | 7,007 / 8,078 / 6,654 ms | 1,766 / 1,760 / 1,747 ms | 7,007 → 1,760 ms (**-74.9%**) |
| First authenticated request | 0.677581 / 0.673737 / 0.695691 s | 0.555498 / 0.554741 / 0.542340 s | 0.677581 → 0.554741 s (**-18.1%**) |

Existing-volume cold container restart (five samples):

| Measure | Median before | Median after | Change |
| --- | ---: | ---: | ---: |
| Restart to `/status.php` | 874 ms | 817 ms | **-6.5%** |
| First authenticated request | 0.623044 s | 0.527750 s | **-15.3%** |

After one warm-up request, 30 sequential authenticated requests had effectively
identical medians with JIT on (0.266152 s) and off (0.265755 s). Thus the cold
latency win did not trade away measured steady-state latency on this route.

### Safety and limits

- Readiness/liveness configuration, Redis/PostgreSQL wiring, PVC durability,
  and `rsync -a --delete` semantics are unchanged.
- Required upgrades are not skipped: app code is now present *before* the
  upstream `occ upgrade`, and `scripts/single-vps-deploy/04-nextcloud-office.sh`
  still runs its strict upgrade reconciliation.
- These are isolated Docker measurements in an Amp orb, not the demo or a
  production k3s deployment. MinIO, ingress/auth-gate, OIDC, and Collabora
  network latency were outside the measured request.
- A real persisted-volume core/app version upgrade was not available locally.
  Verify production rollout logs show the app sync finishing before
  `occ upgrade`, then confirm `occ status` reports `needsDbUpgrade: false`.
