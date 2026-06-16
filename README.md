# work-eu

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

🚧 Planning. See **[docs/PLAN.md](docs/PLAN.md)** for the architecture and
roadmap.

## Repo shape (target)

```
helmfile/          opinionated deploy (k3s default, any conformant k8s)
overlays/          portal theme/config, Keycloak realm, ConfigMaps, glue services
patches/
  upstreamable/    clean, single-concern patches we are submitting upstream → retire when released
  local/           opinionated/integration patches we carry by design
ci/                assembled-stack smoke tests
docs/              operator docs (deploy) + end-user docs (use the portal)
```

Upstream **sources are not vendored** — CI fetches each app at its pinned
release and applies our patch series at build time.
