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
  SHA-256 pinned and its signed SHA-512 manifest is verified before Open Suite's
  one-file asset-MIME patch is applied deterministically.
- Nextcloud Whiteboard `v1.5.9`, the current stable release compatible with
  Nextcloud 34, fetched and checksum-verified in CI.
- `hooks/10-opensuite-apps.sh` — syncs all four apps from the image onto the
  `custom_apps` PVC before installation, before upgrades, and immediately
  before Apache starts. This makes post-install setup and required migrations
  see the image's app versions while retaining a same-version restart fallback
  for opcache (`validate_timestamps=0`).
- `hooks/20-opensuite-whiteboard.sh` — after upgrades, strictly enables
  Whiteboard and reconciles its backend URL and shared JWT secret before
  Apache starts, including on existing-volume and ordinary restart paths.

Built and pushed to `ghcr.io/open-suite/nextcloud` by
`.github/workflows/nextcloud-image.yaml` (tags: the upstream base tag, and
`sha-<commit>`); `user_oidc/`, `richdocuments/`, and `whiteboard/` are fetched
in CI, never committed here.

## Whiteboard release and configuration

Open Suite pins the official `nextcloud/whiteboard` release **v1.5.9**:

- App release: `1.5.9`, upstream source commit
  `2c97cec3150d5e7ec69e04ed98baaf9f138417ff`.
- Artifact:
  `https://github.com/nextcloud-releases/whiteboard/releases/download/v1.5.9/whiteboard-v1.5.9.tar.gz`.
- SHA-256:
  `195e5d0b19fbb7e176bd2c89babfd5514aef0224afe5d0ef239304e84046a1fe`.
- The package metadata declares Nextcloud `min-version="28"` and
  `max-version="34"`; the Nextcloud App Store selects 1.5.9 for server 34.

CI downloads the immutable release URL, verifies the SHA-256 before extraction,
checks the package's embedded certificate CN and SHA-512 manifest entry for
`appinfo/info.xml`, and builds the app into the custom image. The lifecycle
hook uses
`rsync -a --delete` before core/app upgrades and before every start, replacing
an older PVC copy and making repeated reconciliation idempotent. A later
before-starting hook then runs strict `occ app:enable whiteboard` and configures
the backend; unlike optional app-store installs, a missing/incompatible app or
missing backend configuration stops startup.

Nextcloud 34 already maps `.whiteboard` to
`application/vnd.excalidraw+json` and aliases that MIME to the `whiteboard`
icon. The app registers both its `LoadViewer` listener and the Viewer JavaScript
handler for that exact MIME. Do not add local MIME override files for this app.
If migrating a deployment that previously used the obsolete
`integration_whiteboard` app, remove its stale whiteboard entries from
`config/mimetypealiases.json`, then run
`occ maintenance:mimetype:update-db --repair-filecache` and
`occ maintenance:mimetype:update-js` before accepting existing files.

The collaboration backend **is required for durable files in v1.5.9**. Although
parts of upstream's README call it optional for basic editing, the release's
sync code permits only a backend-designated browser to write through to
Nextcloud. Without it, edits remain in that browser's IndexedDB and a reload can
misleadingly appear successful while WebDAV still contains the old file.

Open Suite therefore deploys the official backend image at the matching tag and
immutable manifest digest:

`ghcr.io/nextcloud-releases/whiteboard:v1.5.9@sha256:b60b7633f90d106ac6922f9bc27e1a1ca2442488b740fefdae4c812f34e9cebc`

It runs as one non-root, read-only-root-filesystem pod with an LRU session
cache. A retained Helm-generated 64-character JWT secret is mounted into both
the backend and Nextcloud; it is never placed in values or git. Traefik exposes
the backend same-origin at `https://nextcloud.<domain>/whiteboard`, strips that
prefix as upstream requires, and applies HSTS plus the existing auth-gate
middleware. NetworkPolicy allows ingress only from k3s Traefik in `kube-system`
and egress only to kube-system DNS. The backend makes no outbound Nextcloud call
for ordinary collaboration; recording is intentionally not enabled. No Redis,
service-account token, public backend hostname, or recording storage is added.
This path deliberately fails rendering on non-Traefik ingress until an
equivalent reviewed rewrite and policy are implemented.

### Validation and rollback

- `ci/test-nextcloud-whiteboard.sh` verifies the immutable source contract,
  strict all-start-path enablement/configuration, backend image digest, retained
  secret, auth-gated path rewrite, pod hardening and NetworkPolicy in a render
  of the exact pinned chart.
- `images/nextcloud/test-image-whiteboard.sh` verifies version compatibility,
  core MIME mappings, LoadViewer/Viewer registration, stale-app replacement,
  and repeated-sync idempotence in the built image.
- `ci/smoke/authenticated.mjs` creates a real `.whiteboard`, enters text,
  observes the canonical MIME and persisted marker through WebDAV, reloads an
  editable canvas, and deletes the file. It intentionally does not accept
  `app:list` as proof that the editor works.

The app adds roughly the 114 MiB extracted Whiteboard release to each
architecture of `ghcr.io/open-suite/nextcloud` (registry compression/deduplication
will differ); no release tarball or generated app tree is stored in git. The
deployment also pulls the separately pinned official backend image and adds one
25m CPU / 128 MiB memory-request pod. Before promotion, run the authenticated
browser smoke and confirm `occ status` reports `needsDbUpgrade: false`.

Rollback by restoring the previous `sha-<commit>` Nextcloud image tag and the
previous distribution source, then reapplying Helm; that removes the backend
workload/route while preserving its JWT Secret (`helm.sh/resource-policy: keep`).
Disable the app first with `occ app:disable whiteboard` when rolling back to an
image that predates this integration. Whiteboard 1.5.9 has no app-owned database
migrations, and `.whiteboard` files remain ordinary user files; never delete
them as part of image rollback. The retained Secret can be deleted manually
only after rollback is complete and no Whiteboard deployment consumes it.

## Collabora image picker contract

Collabora's `UI_InsertGraphic` postMessage asks the authenticated Nextcloud
parent page to open richdocuments' `@nextcloud/dialogs` picker. The picker
lists the current user's files directly over same-origin WebDAV: `PROPFIND`
for All files/folders and DAV searches for Recent and Favorites. A selection
is posted to `/apps/richdocuments/assets`; Nextcloud scopes it to that user's
folder and returns a 64-character, ten-minute, one-use bearer URL. The source
route retains richdocuments' configured WOPI-source restriction; behind the
suite ingress, possession of the unguessable token remains the effective
request credential. The extensionless response retains
`Content-Disposition: attachment`, streams the original file bytes, and uses
the selected Nextcloud node's authoritative MIME type (with
`application/octet-stream` only as an empty-MIME fallback). CODE passes the URL
from `Action_InsertGraphic` to its kit; the engine's HTTP/UCB layer may issue a
non-consuming HEAD for `Content-Type` before reading the stream. An extensionless
URL advertised as generic binary gives that path no authoritative JPEG type and
ended in the observed engine-side `Unknown image format` failure. `nosniff` is a
browser policy, not a source-confirmed kit rejection, and is harmless once the
declared MIME is correct. Neither file listing nor asset creation uses the
Collabora WOPI token.

That one-use GET has no browser realm session. The edge auth gate therefore
passes only `GET` and its non-consuming `HEAD` probe for
`/apps/richdocuments/assets/<64 alphanumeric characters>` (with the optional
`index.php` prefix), just like the exact WOPI callback routes. Richdocuments
then enforces both the bearer asset token and its WOPI source-IP allowlist. Do
not broaden this to the assets collection, POST, other token shapes, or nearby
richdocuments routes: asset creation remains an authenticated user action.

Richdocuments 11.0.0 parsed the optional DAV `share-attributes` property
without checking whether it existed. Normal nodes therefore threw
`JSON.parse(undefined)` in the picker filter, leaving All files, Recent, and
Favorites blank even though their DAV requests succeeded. Version 11.0.1
contains upstream's stable34 fix and retains both the readable-file check and
the explicit no-download-share exclusion. Open Suite pins it declaratively so
fresh installs and existing `custom_apps` PVCs receive the same fixed version.
The Office reconciliation step runs `occ upgrade`, enables the app, and fails
the deploy unless the enabled version is exactly 11.0.1.

`test-richdocuments-package.sh` verifies the complete signed upstream package,
then verifies every unmodified packaged file plus the exact patched controller
hash. It pins the guard, permission restriction, PNG/JPEG allowlist, NC34
version contract, one-use/ten-minute asset token, authoritative node MIME with
safe fallback, original-byte stream response, and exact
`Action_InsertGraphic` handoff. The auth-gate tests pin the single 64-character
GET/HEAD bypass and keep malformed tokens, POST, and nearby routes protected.
The live Playwright smoke uploads ordinary JPEGs through Files, verifies their
DAV MIME/magic/SHA-256, covers the rendered All files/Recent/Favorites/folder
picker and error cases, requires an anonymous non-consuming asset HEAD to
return `image/jpeg` directly from Nextcloud, rejects login/HTML/generic-binary
asset responses, and requires two separately tokenized insertions to render
their distinct colours in Collabora's visible document canvas. Message
delivery alone is not accepted as image insertion.

Nextcloud 34 has no supported per-event Activity deletion API. Existing human
demo activity therefore needs one reviewed, exact database cleanup. Select
candidate `oc_activity` rows where `affecteduser` and `"user"` both equal the
human demo user's exact Nextcloud UID, `app = 'files'`,
`object_type = 'files'`, and the final `file` component matches only
`OpenSuite-Smoke-*`, `OpenSuite-Real-JPEG-*`, or the historical
`Open Suite smoke <digits>.whiteboard` fixture. Export and review the IDs, then
delete only that explicit `activity_id` list in a transaction; do not install a
recurring broad name purge. Self-actions do not populate `oc_activity_mq`.
Moving destructive browser fixtures to an isolated test identity is a separate
test-infrastructure follow-up, not part of the image MIME fix.

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
