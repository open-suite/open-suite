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
sudo ./deploy.sh DOMAIN you@example.com 'MASTER_PASSWORD'
```

`deploy.sh` runs `scripts/single-vps-deploy/` in order (every step is
idempotent; re-running is safe):

| Step | What it does |
|---|---|
| `01-deploy.sh` | k3s + cert-manager; clones `MinBZK/mijn-bureau-infra` at the pinned `UPSTREAM_REF`, applies `patches/local/*`, writes the demo values, `helmfile -e demo apply` |
| `02-networking.sh` | single-node workarounds: CoreDNS hairpin rewrite for `*.DOMAIN`, egress NetworkPolicies to Traefik :8443 |
| *(wait)* | blocks until every TLS certificate is issued |
| `03-restart-oidc-apps.sh` | restarts the OIDC apps so they re-read Keycloak discovery |
| `04-nextcloud-office.sh` | warms the Collabora capabilities cache |
| `08-open-suite-portal.sh` | builds and deploys our portal fork (`open-suite/open-suite-portal`) |
| `09-portal-header.sh` | injects the shared Open Suite header into every app |
| `10-keycloak-login.sh` | Keycloak login theme (+ demo credential panel when `OPEN_SUITE_DEMO_MODE=true`) |
| `12-auth-gate.sh` | edge auth gate at `auth.DOMAIN`; ingress attachment is declarative via `patches/local/auth-gate-ingress-middleware.patch` |

Gaps in the numbering are deleted steps whose work moved into
`patches/local/` and helmfile values (tickets 3.4/3.1; all app images —
portal, Meet, auth gate — are CI-built and pinned in the demo values). Result:
`https://bridge.DOMAIN`.

## Repo shape (current)

```
deploy.sh                    entry point (see table above)
scripts/single-vps-deploy/   the numbered steps
patches/
  local/                     opinionated/integration patches applied over the vendored MinBZK infra
  meet/                      patches for the La Suite Meet frontend build (13)
  upstreamable/              (empty) clean, single-concern patches headed upstream — retire when released
overlays/                    auth-gate build context, shared portal header
.github/workflows/           CI: auth-gate image build to GHCR
ci/                          (placeholder) assembled-stack smoke tests
helmfile/                    (placeholder) will absorb the demo values 01 currently writes inline
docs/                        PLAN.md; operator/end-user docs to come
tickets/                     work tracking, one file per ticket
```

The MinBZK infra is **vendored at deploy time**: `01` clones it at the single
pinned commit in `UPSTREAM_REF` and applies `patches/local/*` to a pristine
tree before `helmfile apply` — never a floating branch, never patches on an
already-patched checkout.
