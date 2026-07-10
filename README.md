# Open Suite

An opinionated, self-hostable digital workplace for European public-sector and
privacy-conscious orgs — assembled from best-in-class open-source apps (the
MinBZK **bureaublad** portal, **La Suite Numérique** apps, **Nextcloud**,
**Keycloak**) into one curated, integrated distribution.

We are not building these apps. We **curate** them: pick the good parts, wire
them together behind one login, deploy them one opinionated way, and ship docs
so anyone can stand up the whole stack.

Think of it as a *distribution* (Univention / Cloudron / a Linux distro for
collaboration software), not a fork.

## Status

🚧 Early. There is one working **happy-path deploy** (single VPS / k3s) that
reproduces the live demo (`https://bridge.demo.opensuite.online`). See
**[docs/PLAN.md](docs/PLAN.md)** for the architecture.

## Deploy (single VPS, k3s)

On a fresh Ubuntu 24.04 box (≥12 vCPU, ≥48 GiB RAM) with `*.DOMAIN` pointing at
it, as root, from a checkout of this repo:

```bash
sudo ./deploy.sh DOMAIN you@example.com
```

The installer prompts for the master password without putting it in shell
history or the process list. For unattended runs, point
`OPEN_SUITE_MASTER_PASSWORD_FILE` at a root-readable `0600` file. Re-runs verify
a salted fingerprint and refuse a different password before rendering secrets.

`deploy.sh` runs `scripts/single-vps-deploy/` in order. Steps are designed to be
rerunnable; the master-password guard refuses the credential-changing failure
case before Helmfile runs:

| Step | What it does |
|---|---|
| `01-deploy.sh` | k3s + cert-manager; clones `MinBZK/mijn-bureau-infra` at the pinned `UPSTREAM_REF`, applies `patches/local/*`, writes the demo values, `helmfile -e demo apply` |
| `02-networking.sh` | single-node workarounds: CoreDNS hairpin rewrite for `*.DOMAIN`, egress NetworkPolicies to Traefik :8443 |
| *(wait)* | blocks until every TLS certificate is issued |
| `03-restart-oidc-apps.sh` | restarts the OIDC apps so they re-read Keycloak discovery |
| `04-nextcloud-office.sh` | warms the Collabora capabilities cache |
| `08-open-suite-portal.sh` | installs required Nextcloud integration apps and configures the apex redirect |
| `09-portal-header.sh` | publishes the shared Open Suite header asset (Meet carries the same asset in its image) |
| `10-keycloak-login.sh` | Keycloak login theme (+ demo credential panel when `OPEN_SUITE_DEMO_MODE=true`) |
| `12-auth-gate.sh` | edge auth gate at `auth.DOMAIN`; ingress attachment is declarative via `patches/local/auth-gate-ingress-middleware.patch` |

Gaps in the numbering are deleted steps whose work moved into
`patches/local/` and helmfile values (tickets 3.4/3.1; application images are
CI-built, while the auth-gate image is still pinned in step 12). Result:
`https://bridge.DOMAIN`.

## Where customization lives

Four upstreams are curated without forking, so a change goes in one of three
places depending on WHAT it touches:

| To change… | Put it in… | Applied |
|---|---|---|
| MinBZK helm charts or their values (most config) | `patches/local/*.patch` | at deploy by `01`, `git apply --3way` over the pinned `UPSTREAM_REF` checkout |
| Code inside an app container (Nextcloud apps, patched user_oidc, Element bundle) | `images/<app>/` (Dockerfile + files/patches) | built in CI to GHCR, pinned in the demo values |
| La Suite Meet frontend source | `patches/meet/*.patch` | applied to Meet source in CI, built into `meet-frontend` |
| Browser-side injection (shared portal header) | `overlays/portal-header/` | uploaded as a configmap by `09` |
| The edge auth gate | `overlays/auth-gate/` | built in CI to GHCR |

```
deploy.sh                    entry point (see table above)
scripts/single-vps-deploy/   the numbered steps
patches/local/               chart/values patches over the vendored MinBZK infra (deploy-time)
patches/meet/                La Suite Meet frontend source patches (CI image build)
images/<app>/                custom app images (nextcloud, element) built in CI
overlays/                    auth-gate source; shared portal-header JS
helmfile/                    demo values template 01 renders (demo-values.yaml.tmpl)
ci/smoke/                    assembled-stack smoke tests (run in CI + manually)
.github/workflows/           image builds to GHCR + smoke
docs/ , tickets/             design notes and work tracking
```

The MinBZK infra is **vendored at deploy time**: `01` clones it at the single
pinned commit in `UPSTREAM_REF` and applies `patches/local/*` to a pristine
tree before `helmfile apply` — never a floating branch, never patches on an
already-patched checkout. Fixes we intend to send upstream are not yet split
into a separate bucket; they live in `patches/local/` with the rest.
