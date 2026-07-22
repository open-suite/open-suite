# Open Suite Nextcloud image

Pinned upstream Nextcloud plus:

- `meetcal/` — our Calendar ↔ Meet Nextcloud app (real, lintable source; the
  helm patch only `occ app:enable`s it).
- `user_oidc` at a pinned release with
  `patches/user-oidc-token-exchange-access-token.patch` applied at build time
  (Keycloak 26 standard token exchange rejects
  `requested_token_type=refresh_token`; Meet only needs the access token).
  Upstream PR: (pending — see ticket 3.3).
- `richdocuments` 11.0.1, the NC34-compatible maintenance release containing
  upstream's missing-DAV-`share-attributes` guard. Its official archive is
  SHA-256 pinned and copied unmodified so Nextcloud's package-integrity
  metadata remains valid.
- `hooks/10-opensuite-apps.sh` — syncs all three apps from the image onto the
  `custom_apps` PVC before installation, before upgrades, and immediately
  before Apache starts. This makes post-install setup and required migrations
  see the image's app versions while retaining a same-version restart fallback
  for opcache (`validate_timestamps=0`).

Built and pushed to `ghcr.io/open-suite/nextcloud` by
`.github/workflows/nextcloud-image.yaml` (tags: the upstream base tag, and
`sha-<commit>`); `user_oidc/` and `richdocuments/` are fetched in CI, never
committed here.

## Collabora image picker contract

Collabora's `UI_InsertGraphic` postMessage asks the authenticated Nextcloud
parent page to open richdocuments' `@nextcloud/dialogs` picker. The picker
lists the current user's files directly over same-origin WebDAV: `PROPFIND`
for All files/folders and DAV searches for Recent and Favorites. A selection
is posted to `/apps/richdocuments/assets`; Nextcloud scopes it to that user's
folder and returns a one-use URL that only the configured WOPI server may
fetch. Neither file listing nor asset creation uses the Collabora WOPI token.

Richdocuments 11.0.0 parsed the optional DAV `share-attributes` property
without checking whether it existed. Normal nodes therefore threw
`JSON.parse(undefined)` in the picker filter, leaving All files, Recent, and
Favorites blank even though their DAV requests succeeded. Version 11.0.1
contains upstream's stable34 fix and retains both the readable-file check and
the explicit no-download-share exclusion. Open Suite pins it declaratively so
fresh installs and existing `custom_apps` PVCs receive the same fixed version.
The Office reconciliation step runs `occ upgrade`, enables the app, and fails
the deploy unless the enabled version is exactly 11.0.1.

`test-richdocuments-package.sh` verifies the official production bundle—not
only release metadata—contains the guard, permission restriction, PNG/JPEG
allowlist, and NC34 version contract. The live Playwright smoke covers the
rendered All files/Recent/Favorites/folder picker, empty filtering,
missing-file and unauthorized DAV/asset errors, scoped asset creation, and the
image-selection postMessage path after an image-bearing release is deployed.

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
8.4's tracing JIT (`1255`, 8 MiB): both old- and new-hook comparisons measured
a faster first authenticated request with JIT off, while 30 warmed requests
showed no steady-state benefit from leaving it enabled.

### Method

- Baseline source: `cfd2129853f8aac1dc2a69c923928780138f1f96`
  (`main` before this change); base image `nextcloud:34.0.0-apache`, PHP 8.4.22.
- One Docker network with `postgres:17-bookworm` and `redis:8-bookworm`; every
  fresh sample recreated both the Nextcloud volume and PostgreSQL database.
- Four first-install cells crossed old versus early app synchronization with
  JIT on (`opcache.jit=1255`, 8 MiB) versus off (`disable`, zero buffer). This
  separates the two changes instead of assigning the combined difference to
  either one.
- The timed post-install path starts before `occ app:install user_oidc`, then
  includes strict enablement plus installed-version, enabled-state, and
  Nextcloud-status assertions. This isolates the path changed here; other chart
  app-store installs were not included.
- Startup time runs from immediately before `docker run` to the first HTTP 200
  from `/status.php`. The first authenticated request is the next request:
  `GET /ocs/v2.php/cloud/user?format=json` with Basic auth and
  `OCS-APIRequest: true`.
- `benchmark-startup.sh` is the fail-closed harness for the optimized image. It
  requires the bundled app to report exactly `user_oidc already installed`,
  verifies app/version/status/auth state and the built hook/PHP configuration,
  and expects all three images locally. Run it as
  `sudo ./benchmark-startup.sh IMAGE on|off 3`. Historical old-hook cells and
  existing-volume restart samples used the same timers/assertions manually;
  the committed harness deliberately rejects the old app-store download path.

### Results

#### First-ever installation

Each cell is three fresh PostgreSQL installations; parentheses show the median.

| App sync / JIT | Start to `/status.php` (ms) | Bundled `user_oidc` hook (ms) | First auth (s) |
| --- | --- | --- | --- |
| Old late sync / on | 24,855 / 24,705 / 24,859 (**24,855**) | 7,892 / 7,864 / 8,041 (**7,892**) | 0.674835 / 0.725136 / 0.663904 (**0.674835**) |
| Old late sync / off | 25,564 / 24,337 / 23,181 (**24,337**) | 7,756 / 6,874 / 6,512 (**6,874**) | 0.602040 / 0.575393 / 0.550934 (**0.575393**) |
| New early sync / on | 21,030 / 21,083 / 20,873 (**21,030**) | 3,838 / 3,639 / 3,598 (**3,639**) | 0.752338 / 0.680095 / 0.736938 (**0.736938**) |
| New early sync / off | 19,651 / 19,492 / 19,709 (**19,651**) | 2,809 / 2,829 / 2,746 (**2,809**) | 0.574091 / 0.598702 / 0.558944 (**0.574091**) |

With JIT held constant, early sync reduced first-install startup by 15.4%
(JIT on) and 19.3% (off), and reduced the affected hook by 53.9% and 59.1%.
That identifies hook ordering as the startup/hook improvement. With hook order
held constant, disabling JIT reduced first-auth median by 14.7% (old hook) and
22.1% (new hook). Hook ordering's first-auth effect was not stable across the
three-sample cells, so no separate claim is made for it. The shipped combined
treatment (old/on to new/off) observed 20.9% lower first-install startup, 64.4%
lower affected hook, and 14.9% lower first authenticated request.

#### Ordinary persisted-volume restart

Only `before-starting` runs on this path, and its rsync body is unchanged, so
this comparison isolates the JIT setting rather than the new early hook phases.

| Measure | JIT-on samples (median) | JIT-off samples (median) | Change |
| --- | --- | --- | ---: |
| Restart to `/status.php` | 874 / 880 / 885 / 873 / 868 ms (**874**) | 817 / 857 / 804 / 816 / 835 ms (**817**) | **-6.5%** |
| First authenticated request | 0.622556 / 0.626013 / 0.623044 / 0.623190 / 0.614883 s (**0.623044**) | 0.527750 / 0.549519 / 0.524121 / 0.550067 / 0.523065 s (**0.527750**) | **-15.3%** |

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
