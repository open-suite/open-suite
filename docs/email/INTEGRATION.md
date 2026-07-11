# Email integration — La Suite Messages + European relay

Design and plan for adding email to Open Suite. Decision rationale lives in
`EMAIL-OPTIONS.md`; this is the how. Status: in progress (this PR lays the
groundwork; the deployment chart is the next build step — see "What's left").

## What we are building

La Suite Numérique "Messages" (`suitenumerique/messages`, MIT) as the mail app,
SSO'd into the portal like Docs/Meet, with outbound sending relayed through a
European (non-US) transactional provider so mail reaches Gmail/Outlook inboxes.
This matches the upstream direction: MinBZK is prototyping the same component
(draft PR #621), and it shares our Keycloak/helmfile/single-VPS pattern.

Boundary to be honest about: Messages is web/JMAP, no IMAP by design today, so
it is a browser + PWA experience, not a drop-in for Thunderbird/Outlook/phone
mail apps. Acceptable for a Workspace-style portal; revisit if IMAP is required.

## Why we are NOT vendoring upstream PR #621 as-is

MinBZK PR #621 ("add email") is unmerged and, as of its head commit, a
non-functional Bitnami chart skeleton: templates still contain placeholder
markers (`%%CONTAINER_NAME%%`, `- name: foo`), it defines none of the real
backend/frontend/MTA containers, its environment values file is empty, and it
vendors a full OpenSearch chart wired to nothing. Importing it would add dead
scaffolding and a heavy dependency for zero working behaviour — the opposite of
this repo's zero-slop bar. We track it, but we author the deployment from the
upstream `messages` repo's own `compose.yaml`, which defines every service
correctly, and consume the published images.

## Architecture (from the upstream compose + env contract)

Published images (GHCR, no building needed): `ghcr.io/suitenumerique/messages-{backend,frontend,mta-in,mta-out}` (0.7.0 at time of writing).

Services:
- backend — Django REST API + custom MDA (mail delivery agent). Needs Postgres,
  Redis (Celery broker), OpenSearch (search), S3/object storage (three buckets:
  imports, blobs, static), and OIDC to Keycloak.
- worker — Celery worker (same image/env as backend).
- frontend — Next.js web UI (the Gmail-like inbox).
- mta-in — Postfix, receives mail on port 25, hands each message to the backend
  MDA API (`MDA_API_BASE_URL`, `MDA_API_SECRET`). Needs inbound :25 + a public
  MX record for the mail domain.
- mta-out — Postfix, sends outbound. Supports a smarthost relay via
  `SMTP_RELAY_HOST` / `SMTP_RELAY_USERNAME` / `SMTP_RELAY_PASSWORD` — this is
  exactly where the European relay plugs in.

Dependencies to run on the single VPS: PostgreSQL, Redis, OpenSearch, an
object store (we already run MinIO for Nextcloud; Messages can share or get its
own). OpenSearch is the heavy one (multi-GB heap, raised ulimits) — the real
resource cost of this feature, and the reason it must ship behind an
`application.messages.enabled` flag defaulting off.

## Outbound: European relay (Brevo primary, provider-swappable)

`mta-out` takes a smarthost, so the relay is a three-field config, not a code
change:

```
SMTP_RELAY_HOST=[smtp-relay.brevo.com]:587
SMTP_RELAY_USERNAME=<brevo SMTP login>
SMTP_RELAY_PASSWORD=<brevo SMTP key>
```

The credentials live in a Kubernetes secret (`overlays/messages/brevo-relay-secret.example.yaml`),
referenced by the mta-out container env. Swapping Brevo for Sweego/Scaleway/
Mailjet is changing the host + secret — no rework. Per-message pricing (Brevo
free tier covers demo volume). See `EMAIL-OPTIONS.md` for the provider
comparison and why a US relay (SES) is excluded.

DNS for the mail domain, required for deliverability (set once, at deploy):
- SPF: `v=spf1 include:<relay SPF> -all` (Brevo publishes the include).
- DKIM: the CNAME/keys the relay generates for your domain (relay signs with
  domain alignment so the visible From matches the authenticated domain).
- DMARC: `v=DMARC1; p=quarantine; rua=...`.
- MX: for inbound, `mail.<domain>` (or the mail subdomain) pointing at the box,
  plus PTR/reverse-DNS on the box IP.

## OIDC / Keycloak

Messages authenticates against Keycloak. It needs, in our `mijnbureau` realm:
- a public client `messages` (frontend login: OIDC_RP_CLIENT_ID/SECRET,
  redirect URIs on `https://messages.<domain>`), and
- a confidential service-account client `rest-api` (backend↔Keycloak admin for
  mailbox/group provisioning: KEYCLOAK_CLIENT_ID/SECRET,
  KEYCLOAK_GROUP_PATH_PREFIX).

These are added declaratively to the realm import (a `patches/local` realm
patch), mirroring how the other apps' clients are managed — authored with the
chart so the client and the app land together (a client for an undeployed app
is dead config, so it is not in this groundwork PR).

## Portal

Add a "Mail" entry to the portal top nav pointing at `https://messages.<domain>`,
gated so it only appears when `application.messages.enabled` is true (a nav link
to an undeployed host is a broken-link regression, so it ships with the backend,
not before).

## What's left (the deployment build, next)

1. Author a helmfile `messages` app in our model from the upstream compose:
   backend + worker + frontend + mta-in + mta-out (published images), wired to
   Postgres/Redis/OpenSearch/object-store and to Keycloak, behind
   `application.messages.enabled` (default off). Verify with `helmfile template`.
2. Realm patch: `messages` + `rest-api` clients.
3. mta-out relay secret + env (Brevo), from the example here.
4. Portal "Mail" nav entry (gated on the feature flag).
5. Deploy-time, on the demo (coordinate — a benchmark is currently running):
   OpenSearch capacity check, open inbound :25, MX + SPF/DKIM/DMARC + PTR, a
   Brevo account + SMTP key, then verify send to Gmail/Outlook lands in inbox
   and inbound receive works. Add a smoke assertion for the mail app.

Blocked on, for a live demo: OpenSearch fits the box; inbound port 25 + MX;
a Brevo (or chosen relay) account; a maintenance window that does not collide
with in-flight benchmarking.

## Sources
- La Suite Messages: https://github.com/suitenumerique/messages (compose.yaml, env.d/)
- MinBZK draft PR #621 (skeleton): https://github.com/MinBZK/mijn-bureau-infra/pull/621
- Decision + provider comparison: ../../EMAIL-OPTIONS.md
