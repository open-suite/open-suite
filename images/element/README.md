# Open Suite Element Web image

`ghcr.io/open-suite/element-web` — the pinned upstream `vectorim/element-web`
v1.12.24-rc.1 image with Element's device-verification reminder toasts patched out of the
static bundle at build time. Its nginx configuration also gzip-compresses
textual responses, including Element's JavaScript, CSS, JSON, SVG and WebAssembly
assets.

The image also applies the compiled equivalent of
`patches/replace-sso-history.patch`, derived from Element source commit
`eebdc77379814380baeeffb8f41da5e4f2063c86` (`v1.12.24-rc.1`). Upstream starts
browser SSO with a normal `location.href` navigation, which retains the pre-SSO
Element entry. Open Suite uses `location.replace` so the eventual token-cleaned
callback is the only Element entry above the referring Portal page. Callback
construction, token cleanup, home/room fragments, and authentication itself
are unchanged.

The image precompresses only the content-hashed files under `bundles/` at the
same gzip level used by nginx, then serves those copies with `gzip_static`.
Mutable runtime files such as `config.json` are deliberately excluded so a
generated configuration can never be shadowed by a stale build-time `.gz`
file. Dynamic gzip remains enabled for non-bundle textual responses.

The final stage also contains only one Element application tree. Building on
the upstream image and copying a patched `/app` over it retained both the old
and renamed bundle directories in separate layers. Besides wasting cold-pull
and unpack time, that left the old unpatched immutable URL reachable. The image
now flattens the exact upstream runtime without `/app`, then adds the patched
tree once. The upstream non-root user, entrypoint, stop signal, exposed port and
`config.json` health check are re-declared, with their Dockerfile presence
guarded in CI.

The image also inserts an HTML preload for Element's hashed Rust E2EE
WebAssembly module. Element otherwise discovers the 1.8 MiB module only after
its main bundle has executed, leaving its transfer directly on the room-list
startup path. The build locates the pinned image's exact hashed filename and
fails if that assumption drifts.

Element redirects mobile browsers to a native-app guide before loading its
runtime config. The image sets Element's opt-out cookie in the initial HTML
response and redirects stale `/mobile_guide` URLs to the web app; the Helm
config also disables the later mobile-guide toast.

## Why

Open Suite runs chat without default room encryption (a Slack-like experience,
`synapse-disable-default-e2ee` + `element-e2ee-default-off`). Element still
registers verification-reminder toasts from its compiled bundle, and the config
flag that used to hide them was removed upstream. The only lever left is editing
the shipped bundle.

This used to be a runtime `initContainer` (`11-element-web.sh`) that a bare
`helmfile apply` reverted — so the reminders came back on every re-apply. Baking
the edit into the image makes it survive re-applies (Phase 2.2).

## How it stays honest

The patch scripts assert the exact minified fragments they rewrite are present
before patching and gone after. If an image bump ships a different bundle, the
build fails loudly instead of silently shipping an unpatched Element. Bump
`ELEMENT_TAG`, verify the source patch against the pinned tag, and re-derive
the compiled match strings together.

## 2026-07-20 cold-start investigation

The baseline was the exact current image
`ghcr.io/open-suite/element-web:sha-253492c` (OCI index
`sha256:fd7c62d150c2a49aa13101dffc24d97a7b7b6ffbaa2385ff1ff66f6ab95a318d`).
The candidate was built from this Dockerfile as local image
`sha256:ea381537c8de4235d17b97ce90c4d55ae73cdb91b53e9e5eda64ed872c5ffad3`.
Measurements ran in the same 16-vCPU x86-64 Amp orb with 31 GiB RAM, Linux
6.1.158, Podman 4.3.1/crun, Node 20.9.0 and, where applicable, Playwright 1.55.1
with Chromium 140.0.7339.186. Raw reports were written under `/tmp`; the
reproducible harnesses are the `benchmark-element-*.mjs` files in this
directory.

### Element container and image

| Metric | Baseline | Candidate | Change |
| --- | ---: | ---: | ---: |
| Local OCI compressed layers | 90,496,241 B / 16 | 69,890,209 B / 4 | -22.8% bytes |
| Unpacked image size | 286,714,403 B | 207,368,036 B | -27.7% |
| Fresh image load p50 (IQR), n=10 | 5,726.7 ms (179.2) | 3,044.3 ms (43.0) | -46.8% |
| Fresh image load p75 | 5,811.6 ms | 3,061.2 ms | -47.3% |
| Warm container create p50 (IQR), n=20 | 52.1 ms (3.6) | 50.1 ms (3.8) | -3.9% |
| Warm start-to-health p50 (IQR), n=20 | 475.8 ms (25.2) | 491.5 ms (21.2) | +3.3% |
| Warm start-to-health p75 | 491.9 ms | 503.3 ms | +2.3% |

Fresh-load samples alternated variants and loaded each local OCI archive into a
new Podman `vfs` root/runroot, so every sample paid decompression and filesystem
materialization without registry/network variance. Warm process samples also
alternated variants and polled the same `/config.json` health endpoint. The
small warm-health regression is retained rather than hidden; it is 15.7 ms at
the median and the candidate's nginx files and process are unchanged.

Filesystem comparison found 3,930 shared entries with identical type, mode,
owner and SHA-256. The baseline alone had 160 entries, all under the old
`bundles/551980ded8b2e300e6f2` directory; the candidate has only the patched
`551980ded8b2e300e6f2-oscda39b101f` directory. Both variants passed `nginx -t`,
served the preload and 73 valid static-gzip files, and used the same non-root
runtime contract and health request.

The release build pins that verified multi-arch Element runtime as
`v1.12.24-rc.1@sha256:a72c9310c08ebc7c4cb4fb91911b1363e529834e031468130eb75cea90027064`
(`amd64@sha256:a26bdc3bec8cad42ad3fafa180386706f99d8a6be41e6f1d775292b820a2597b`,
`arm64@sha256:ceb899e0face56a6ad8196e458c9c45ad7e8446235b623df1893cd653611bd50`)
and the Perl patcher as
`5-slim@sha256:d9e618def9ecf01ac2aafdf1ee39e6ea42833ae84a947b9feb44a677382f3f81`.
The image workflow builds and loads the final amd64 and arm64 images before it
may publish the multi-arch result. For each platform it compares Env,
Entrypoint, Cmd, User, WorkingDir, ExposedPorts, StopSignal and Volumes with the
pinned upstream config; checks the exact re-declared Healthcheck; requires all
upstream labels (allowing Open Suite OCI metadata); and executes one-bundle,
symlink and gzip-integrity guards. The amd64 candidate additionally must pass
`nginx -t`, the image's unchanged `config.json` health request and JSON parsing
of the served config. This guards the filesystem/config coupling introduced by
flattening rather than relying only on Dockerfile text assertions.

### Browser parse/load

Ten samples each launched a fresh Chromium process and context against the
extracted exact baseline `/app`, using a deterministic local Matrix `/versions`
and SSO-flow mock. Readiness was the visible `Open Suite SSO` action after
opening Element's sign-in view. There was no CPU/network throttling.

| Cold browser metric | p50 | p75 | IQR |
| --- | ---: | ---: | ---: |
| Main `bundle.js` response end | 11.6 ms | 12.7 ms | 1.2 ms |
| E2EE WASM response end | 78.4 ms | 80.1 ms | 5.1 ms |
| DOMContentLoaded | 38.2 ms | 41.5 ms | 5.5 ms |
| FCP | 504.0 ms | 508.0 ms | 23.0 ms |
| Long-task time | 275.0 ms | 279.5 ms | 8.5 ms |
| Visible SSO action | 648.1 ms | 668.2 ms | 32.0 ms |

Every run loaded 45 resources and 15,491,407 decoded bytes. Static delivery was
finished long before first paint; main-thread initialization/React rendering is
the dominant pre-login phase. Rotated ten-sample experiments removing the WASM
preload, moving it earlier, adding `fetchpriority=high`, or adding `defer` to the
body-end script did not beat observed spread: visible-readiness medians were
655.5, 654.0, 676.0 and 639.0 ms respectively versus 653.0 ms for that
experiment's baseline. The preload remains because the login-only test cannot
exclude a post-SSO E2EE regression.

### Synapse startup and database initialization

Synapse v1.155.0 was sampled in isolated Podman containers against PostgreSQL
16 and Redis, using the distribution's monolith, PostgreSQL, background-update,
password-disabled and login-rate-limit shape. No live cluster was restarted or
deployed.

| Startup phase | Samples | p50 | p75 | IQR |
| --- | ---: | ---: | ---: | ---: |
| Warm container create | 13 | 46.0 ms | 46.0 ms | 1.0 ms |
| Initialized DB: start to `/health` | 13 | 4,075.0 ms | 4,138.0 ms | 91.0 ms |
| Fresh PostgreSQL: start to ready | 6 | 822.5 ms | 879.0 ms | 84.0 ms |
| Fresh schema: Synapse start to `/health` | 6 | 4,749.5 ms | 4,797.0 ms | 97.0 ms |
| Fresh PostgreSQL start through Synapse health | 6 | 5,645.0 ms | 5,739.0 ms | 113.0 ms |

On an initialized database, logs took about 53 ms from Synapse's first startup
message through database consistency checks to `Running`, and about 117 ms to
the listener. Roughly 3.9 seconds occurred earlier in entrypoint/Python import.
Fresh schema creation applied all recorded v73-v76 deltas and added only about
0.7 seconds; migrations are not the dominant phase and remain untouched.

The chart currently waits 15 seconds before its first startup probe despite all
19 measured initialized/fresh runs becoming healthy within five seconds. The
`synapse-startup-probe.patch` changes that first identical `/health` request to
five seconds and raises failures from five to seven. At a five-second period,
the first successful observation is 10 seconds earlier while the final failure
deadline remains approximately 35 seconds. This is a probe-scheduling result,
not a claimed Synapse process-speed improvement, and still needs staging/K3s
confirmation.

### First SSO sync boundary

The existing live-demo one-time portal-to-room-list sample was 5,264 ms. To
separate server work without demo credentials or deployment, ten local samples
created a unique post-identity user, issued a local access token as a proxy for
completed OIDC verification, joined one seeded welcome room, then made a first
`/sync` with lazy members and a 20-event timeline. Samples were paced 700 ms and
kept all configured rate limits.

| Post-identity Synapse phase | p50 | p75 | IQR |
| --- | ---: | ---: | ---: |
| Create local user | 22.0 ms | 23.1 ms | 2.3 ms |
| Issue access token | 4.4 ms | 4.9 ms | 0.8 ms |
| Auto-join seeded room | 65.7 ms | 67.5 ms | 4.3 ms |
| Initial sync | 50.0 ms | 52.6 ms | 3.2 ms |
| Initial sync payload | 14,328 B | 14,673 B | 689 B |

This isolates Synapse's post-verified-identity work; it intentionally does not
pretend an admin-issued local token measures Keycloak authorization, OIDC token
exchange, or Element's Rust-crypto initialization. Those browser/OIDC/crypto
steps, plus the 275 ms local main-thread work, remain the dominant first-login
investigation target. Optimizing them requires an authenticated staging run or
an upstream source-level Element split, not minified surgery that could weaken
E2EE or session/storage consistency.

### Reproduce

```bash
# Build and compare warm container startup (rootless engines may not need sudo).
sudo podman build --format docker -t localhost/opensuite-element:candidate images/element
ELEMENT_CONTAINER_ENGINE='sudo podman' \
ELEMENT_CANDIDATE_IMAGE=localhost/opensuite-element:candidate \
node images/element/benchmark-element-container.mjs

# Browser profile after extracting the baseline image to /tmp/element-image.
npm ci --prefix performance
npx --prefix performance playwright install chromium
mkdir -p /tmp/element-image
crane export ghcr.io/open-suite/element-web:sha-253492c - \
  | tar -x -C /tmp/element-image
ELEMENT_APP_DIR=/tmp/element-image/app \
node images/element/benchmark-element-browser.mjs

# Loopback-only post-identity sync profile against an isolated seeded Synapse.
ELEMENT_SYNAPSE_ADMIN_TOKEN_FILE=/tmp/admin-token \
ELEMENT_SYNAPSE_ROOM_ID='!seeded-room:matrix.profile.test' \
node images/element/benchmark-element-first-sync.mjs
```

Pinned in the demo values as `container.elementweb` (see `01-deploy.sh`).
