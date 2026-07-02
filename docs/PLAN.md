# open-suite — Plan

## 0. Status vs plan (2026-07)

Shipped: the single-VPS k3s happy path (`deploy.sh`, idempotent, verified by a
full re-apply on the live demo 2026-07-02); SSO across every app; calendar +
Meet integration (see §5 — shipped as the meetcal Nextcloud app, not the
webhook listener this plan first sketched); Keycloak branding + session
lifetimes, Element E2EE-off, the edge auth gate — all declarative as
`patches/local/*` over the pinned MinBZK infra (`UPSTREAM_REF`), applied by
`helmfile apply` alone (ticket 3.4).

Shipped differently: MinBZK infra is vendored at deploy time (pinned clone +
patch series), not fetched by CI; the portal is a owned fork
(`open-suite/open-suite-portal`), not a patch queue.

Doesn't exist yet: assembled-stack smoke test in CI (§2.2, ticket 3.6 — only
the auth-gate image build is in CI), updatecli pinning, the upstreamable patch
queue with provenance trailers (§4 — `patches/upstreamable/` is empty),
pristine-build (`git am`) image pipeline (§4), registry images for portal and
Meet (built on-box today, ticket 3.1), backups/restore drill (§6, M4).

## 1. What this is

An **opinionated distribution** of an open-source digital workplace. We assemble
existing apps into one integrated, deployable product — curating, integrating,
and theming rather than building from scratch.

Components (current set):

| Capability        | App                          | Source                        |
| ----------------- | ---------------------------- | ----------------------------- |
| Portal / launcher | bureaublad                   | MinBZK/bureaublad             |
| Files             | Nextcloud                    | nextcloud (official image)    |
| Office editing    | Collabora (CODE)             | collabora-online              |
| Docs (block doc)  | La Suite Docs                | suitenumerique/docs           |
| Video             | La Suite Meet (LiveKit)      | suitenumerique/meet           |
| Tables            | Grist                        | gristlabs/grist               |
| Chat              | Element / Synapse (Matrix)   | element / matrix              |
| **Calendar**      | Nextcloud Calendar (interim) | nextcloud `calendar` app      |
| Email (planned)   | La Suite Messages            | suitenumerique (PR upstream)  |
| Identity          | Keycloak                     | keycloak                      |

We are **more opinionated than MinBZK**: fewer choices, one blessed way to
deploy, a defined portal experience, integrations wired by default.

## 2. The integration thesis

Two things make these apps "work nicely together" — patches are a distant third:

1. **Keycloak / OIDC is the spine.** One realm, one login, consistent identity
   across every app. Most of "integrated" = every app trusting the same issuer.
   This is the centre of gravity of the repo.
2. **An assembled-stack smoke test in CI.** Our value prop is integration;
   integration is exactly what silently breaks on an upstream bump or a patch
   rebase. CI must bring up the whole helmfile and assert: SSO login works,
   calendar loads in the portal, creating an event mints a Meet link, docs
   open, etc. We retire patches **green**, not hopeful.

## 3. Customization strategy — match the technique to the change

Hard-forking everything is the failure mode. Use the lowest-cost layer that
works; only descend a row when there is genuinely no extension point.

| Change                                   | Technique                              | Fork source? |
| ---------------------------------------- | -------------------------------------- | ------------ |
| Branding, theme, enabled apps, URLs      | Deploy-time: Helm values, ConfigMaps, env, `occ` | No |
| Add apps/plugins (NC Calendar, NC app)   | Image overlay: `FROM upstream` + install         | No |
| Cross-app behaviour (Calendar→Meet glue) | Companion sidecar / small service                | No |
| Behaviour with no upstream hook          | **Patch queue** applied at build                 | Yes (as patches) |

Most customization is **not** source. Reserve patches for the few cases with no
hook.

## 4. Patch workflow — carry-and-upstream

We move fast locally, submit upstream in parallel, and retire local patches once
the fix ships in a release we've pinned to. (Same model as AOSP / Chromium
downstreams.)

**Two buckets, only one is meant to retire:**

- `patches/upstreamable/` — clean, single-concern, *literally the PR diff*.
  Trends to zero. Health metric = count + age of oldest.
- `patches/local/` — opinionated/integration patches upstream will never take.
  Carried forever by design.

**Provenance trailer on every upstreamable patch** so retirement is a grep:

```
Upstream: https://github.com/<org>/<repo>/pull/123
Status: submitted   # → merged → released
```

**Build = pristine + patches:**

1. `git clone upstream @ <pinned tag>` (tag tracked by updatecli)
2. `git am patches/<app>/*.patch`
3. build image → push to our registry

**Retire on *released*, not *merged*.** A PR in upstream `main` isn't in our
pinned tag yet — dropping it early loses the fix. The signal is automatic: on a
version bump, `git am` fails ("already applied") on the now-redundant patch →
that's the cue to delete it. Retiring must keep the smoke test green.

**Sources are not vendored.** The repo holds patches + overlays + deploy + docs.
Sources are pulled at build time (pinned submodule only for apps we patch
heavily, e.g. bureaublad).

## 5. Calendar (shipped — meetcal)

No calendar ships in MinBZK or La Suite prod yet (tracked: MinBZK/mijn-bureau-infra
#585). La Suite's prod calendar today is **Open-Xchange** (behind its Messagerie);
a native `suitenumerique/calendars` app exists but has no release. What we ship:

- **Nextcloud Calendar** (CalDAV) is the calendar; the portal links to it on the
  Nextcloud origin (Nextcloud sends `frame-ancestors 'none'`, so no iframing).
- **Meet integration (Google-Cal-style auto link)** is live, built differently
  than first planned. The webhook-listener design was abandoned; instead a small
  Nextcloud app, **meetcal** (`patches/local/nextcloud-meetcal.patch`, mounted
  from a ConfigMap), exposes `POST /apps/meetcal/room`: it mints a `meet` token
  via user_oidc **token exchange** (Keycloak standard token exchange enabled on
  the realm client) and create-or-gets a public room with a `xxx-yyy-zzz` slug —
  the only slug format Meet treats as joinable. The portal header overlay adds
  the "Add Meet link" button and auto-fills new events; the link lives in the
  event location, so the portal widget shows "Join".
- **Later:** migrate to native `suitenumerique/calendars` when released — at
  which point meetcal and the header glue are deletable interim glue.

## 6. Deployment target

- **k3s** is the default substrate — CNCF-conformant, single-binary, batteries
  included. Ideal for the per-org **appliance** model (one cluster per customer).
- **Single node + vertical scaling.** Comfortable to ~200 users on one big node
  with NVMe. The limits are RAM-per-Collabora-session and disk IO, not user count
  or CPU. Backups (not replication) provide durability.
- **Durability = tested restore, not HA.** CNPG base/WAL backups + MinIO/Nextcloud
  data backed up off-box. Accept a short restore window on node/disk failure.
- **Stay portable.** Plain Helm/helmfile + Gateway API + cert-manager + CNPG — no
  hard dependency on k3s-only bits (klipper svclb, local-path). Default to k3s,
  but the same helmfile runs on any conformant cluster a customer already has.
- HA (3-server embedded etcd + Longhorn) is a documented option, not the default.

## 7. Licensing

Nextcloud is AGPL; distributing a modified appliance carries source-availability
obligations. Being patch-based and public keeps us compliant by construction —
do not let it drift into a private fork.

## 8. Open questions

- Meet guest admission on auto-created rooms (gates the simplest calendar glue).
- Default ingress: embrace bundled k3s Traefik, or `--disable traefik` + explicit
  Gateway API. Pick one and standardize.
- Which apps are in the v1 blessed set vs optional.

## 9. Roadmap

1. **M0 — foundation:** repo, this plan, CI scaffold, pin the upstream set with
   updatecli, helmfile that stands up the current stack on k3s with Keycloak SSO.
2. **M1 — calendar:** Nextcloud Calendar in bootstrap + portal wiring + Meet
   webhook glue; first end-to-end smoke test.
3. **M2 — patch pipeline:** build = pristine + `git am`; provenance trailers;
   first upstreamable patches submitted (e.g. bureaublad `CALENDAR_URL`).
4. **M3 — docs:** operator deploy guide + end-user portal guide.
5. **M4 — backups + restore drill;** document single-node sizing and the HA option.
