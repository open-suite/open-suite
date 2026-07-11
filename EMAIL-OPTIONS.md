# Email options for Open Suite

Open Suite curates an office suite that can replace Google Workspace / Microsoft
365 with no US-jurisdiction dependency. Email is the missing pillar and the
hardest one, because deliverability is a reputation problem you cannot fully
self-host. This document records the options considered and the recommendation.

Constraint that rules the decision: no US-headquartered provider, even one with
EU datacentres — a US company is subject to US law (CLOUD Act, FISA 702)
regardless of where the bytes sit. That excludes Google, Microsoft, Amazon SES,
and US-incorporated hosts (e.g. Purelymail runs on AWS us-east-1). It does not
exclude Switzerland or the EU/EEA.

## Recommendation (1): managed European mailbox provider, wired in over IMAP/SMTP

Outsource the mail transport and storage to a European, non-US-law provider that
speaks standard IMAP/SMTP and exposes a provisioning API; surface it through a
standards webmail (Roundcube) single-signed-on into the portal, and provision
mailboxes per demo domain via the provider's API. Do not run our own MTA.

Primary pick: Infomaniak (Switzerland, employee-owned, its own datacentres).
It has a free REST API (OAuth2) for mailbox/alias/filter provisioning, full
IMAP/POP/SMTP, ISO 27001/9001/14001/50001 + Swiss Hosting + B-Corp, at roughly
CHF 1.76/user/month. EU-jurisdiction alternates: mailbox.org (Germany, OX-based,
documented reseller REST API) and OVHcloud email (France, the only candidate
with SecNumCloud/ANSSI qualification — pick this if French public-sector
procurement is a target).

Why this is number 1, given the stated willingness to outsource email:
- It removes the one genuinely impractical thing to self-build — last-mile IP
  reputation and inbox placement at Gmail/Outlook (see "the deliverability
  tax" below). The provider owns warmed, reputable IP pools.
- It stays sovereign: Swiss/EU jurisdiction, no US legal exposure, data in
  Europe.
- It stays standards-based (IMAP/SMTP), so it is not a walled garden and swaps
  out later for self-hosting or La Suite Messages without changing the user
  experience — same Roundcube, same portal SSO.
- It is deployable now for the demo: a provider account + API token + a Roundcube
  chart wired to Keycloak, versus weeks of IP warm-up and DNS/DNSSEC work.

What ships: a `mail` app (Roundcube webmail, OIDC via Keycloak) added to the
portal nav; IMAP/SMTP pointed at the provider; a small provisioning step that
creates mailboxes for demo users via the provider API. The provider is a
config choice, not a hard dependency — the chart takes IMAP/SMTP host + creds.

Separate from user mailboxes, the suite needs a transactional relay for system
mail (password resets, invites, notifications) regardless of which mailbox
option is chosen — see option B′ below. A pay-per-message European relay
(Scaleway TEM) covers that, and is also the outbound half of the self-host
path. So the relay is wanted in every scenario; the per-user-vs-per-message
question is only about the user-mailbox tier.

## The deliverability tax (why "just self-host email" is the trap)

Running a mailbox is the easy 20%; getting mail from a fresh VPS IP into
Gmail/Outlook inboxes is the hard 80%, and it is reputation, not configuration:

- A brand-new Hetzner/VPS IP looks like the throwaway infra spammers burn, so
  receivers distrust it by default; recycled IPs are often already on Spamhaus.
- Port 25 egress is blocked by default at many hosts (Hetzner included).
- PTR/reverse DNS must match the mail hostname; most VPS IPs lack it out of box.
- Since November 2025 Google/Yahoo/Microsoft enforce SPF and DKIM and DMARC with
  alignment, one-click unsubscribe for bulk, and a spam-complaint rate under
  0.3%. MTA-STS and DANE/TLSA (DNSSEC) are increasingly expected by strict EU
  and government receivers.
- Even with every record perfect, a cold IP needs weeks of low-volume warm-up.

So any self-hosted answer in 2026 realistically means the hybrid below —
self-host the mailbox, relay outbound through a provider's warmed IPs — or you
accept that demo mail lands in spam. Saying this plainly is more credible than
pretending a fresh VPS reaches the inbox.

## All options considered

### A. Managed EU mailbox provider — RECOMMENDED (option 1 above)
Standards IMAP/SMTP from a Swiss/EU provider with a provisioning API, behind our
own Roundcube + Keycloak. Infomaniak / mailbox.org / OVHcloud / IONOS / Migadu
all qualify (server-side IMAP, provisionable). Open-Xchange (OX App Suite) is the
white-label engine several of them and openDesk/IONOS run on; consumable as OX
Cloud or self-hosted, best-in-class multi-tenant provisioning, but partner-only
pricing. Verdict: fastest sovereign path, lowest ops, keeps standards.

### B. Hybrid self-host: Stalwart mailbox + EU outbound relay (pay-per-message)
Self-host inbound/storage/IMAP/JMAP/webmail on the k3s box with Stalwart Mail
Server (Rust single daemon: SMTP/IMAP/JMAP/POP3/CalDAV/CardDAV, built-in spam
filtering, OIDC/Keycloak auth across the whole server, AGPL, k8s StatefulSet
docs). Relay outbound through a European SES-alternative on 587/465 to borrow
warmed IPs and dodge port-25 blocks; SPF includes the relay, relay DKIM-signs
with alignment. Verdict: strongest sovereignty with real deliverability; medium
ops; the right endgame if we want to own the mailbox. Stalwart is the standout
self-host engine — the only one that closes the OIDC loop end-to-end and is
JMAP-native. See "the pay-per-message model" below for why the relay economics
often beat per-user for this shape.

### B′. European SES-alternative for outbound (pay-per-message) — the relay tier
A European transactional-email API/SMTP relay is the sovereign equivalent of
Amazon SES, billed per message rather than per user. Primary pick: Scaleway
Transactional Email (France, Iliad) — SES-style API + SMTP, €0.25 per 1,000
emails, 300/month free, no fixed monthly fee, EU datacentres. Alternates:
Sweego (FR), Mailjet (FR, GDPR/ISO), Brevo (FR), all EU/EEA.

This is not a standalone email solution — a relay only sends. It has no mailbox
storage and no IMAP/receiving, so it cannot be the user-inbox tier by itself. It
is exactly the outbound half of option B, and it independently covers a need the
suite has regardless of user mailboxes: transactional/system mail — password
resets, calendar and share invitations, notifications (MinBZK flags this same
need in mijn-bureau issue #86). Even if user mailboxes live at a managed provider
(A) or are deferred, Open Suite still needs a relay for system mail, and a
per-message EU relay is the right tool for it. Verdict: adopt B′ for outbound
and system mail in every scenario; pair with A or Stalwart for receiving/storage.

### The pay-per-message model vs per-user

Managed mailbox providers (A) bill per user per month (~€1-3), so cost scales
with headcount whether or not people send much. A relay (B′) bills per message
(Scaleway: €0.25/1000, effectively free at demo volume), so cost scales with
send volume. For a demo — few users, low volume — self-host the mailbox
(Stalwart) plus a per-message relay is close to free and fully sovereign, at the
cost of running Stalwart. For a large low-send deployment the per-message model
is also cheaper; for heavy senders, per-user can win. The two models compose:
you can always self-host storage and pay per message for sending, which is the
cheapest sovereign shape when you are willing to run the mailbox.

### C. Full self-host, no relay (Stalwart or Mailu/Mailcow, own IP)
Own everything including the sending IP. Verdict: maximum sovereignty on paper,
but the deliverability tax makes it a bad bet for a demo and a support burden
for self-hosters. Mailu is the most k8s-friendly traditional bundle
(Postfix/Dovecot/Rspamd/Roundcube, Helm chart); Mailcow is batteries-included
but officially not Kubernetes-friendly and wants 4-6 GB RAM; docker-mailserver
is minimal-but-DIY. Keep as a documented "you're on your own IP" path, not the
default.

### D. La Suite Numérique "Messages" — the sovereign-OSS endgame to track
`suitenumerique/messages` (France, ANCT/DINUM, MIT, ~v0.8): a from-scratch
collaborative inbox — Postfix MTA + a custom Django MDA, OpenSearch, Celery,
Keycloak SSO, JMAP-inspired. This is what MinBZK upstream is prototyping for
mijn-bureau (draft PR #621), and it shares Open Suite's exact SSO/deploy pattern.
Two blockers today: it is pre-1.0 and early, and it has no IMAP/POP by design
(web/JMAP only) — so it is not a drop-in mailbox for Thunderbird/Outlook/phone
users yet, and it still needs the same outbound-deliverability answer as B/C.
Verdict: adopt when it matures; track upstream, do not block the demo on it.

### E. Walled-garden privacy providers (Proton, Tuta) — REJECTED
Swiss/German and sovereign, but proprietary encrypted stores: Proton needs a
per-device Bridge app for IMAP/SMTP and has no clean provisioning API; Tuta has
no IMAP/SMTP at all. Neither integrates with a standards webmail or multi-domain
provisioning, so neither fits a distribution. Sovereign, wrong shape.

### F. US providers (Google Workspace, M365, Amazon SES, Purelymail) — REJECTED
The thing we exist to avoid: US-headquartered, therefore US-law-exposed
regardless of datacentre location.

## Tradeoff matrix

Scores: ++ strong, + ok, ~ mixed, - weak, -- disqualifying.

| Option | No US law | EU data residency | Deliverability | Ops burden | Portal/SSO integration | Standards (not walled) | Cost | Maturity |
|---|---|---|---|---|---|---|---|---|
| A. Managed EU provider (Infomaniak/mailbox.org/OVH) | ++ | ++ | ++ | ++ (none of ours) | + (Roundcube+OIDC) | ++ | + (~€1-3/user/mo) | ++ |
| B. Stalwart + EU outbound relay | ++ | ++ | + | ~ | ++ (native OIDC/JMAP) | ++ | + (relay per-volume) | + |
| C. Full self-host, own IP | ++ | ++ | -- | - | ++ / + | ++ | ++ (infra only) | + |
| D. La Suite Messages | ++ | ++ | ~ (needs relay) | ~ | ++ (same stack) | ~ (no IMAP yet) | ++ | - (pre-1.0) |
| E. Proton / Tuta | ++ | ++ | ++ | + | -- (Bridge/none) | -- | ~ | ++ |
| F. Google / M365 / SES | -- | ~ | ++ | ++ | + | + | ~ | ++ |

## Reading of the matrix

The constraint (no US law) removes column-F outright. Among the survivors, the
split is deliverability-and-ops (A) versus own-the-mailbox sovereignty (B/D).
Given email is explicitly the one component we are willing to outsource, and
that deliverability is the single thing that is impractical to self-build, A
wins for now: sovereign, standards-based, integrates cleanly, ships this week.
B is the natural next step for operators who want the mailbox in-house, and D
is the open-source endgame we track upstream and adopt when it is ready. The
architecture keeps all three interchangeable because everything hangs off
IMAP/SMTP + a Keycloak-SSO'd Roundcube, so choosing A now does not lock us out
of B or D later.

## Concrete next steps for Open Suite

1. Wire a European transactional relay (Scaleway TEM) for system mail now —
   password resets, invites, notifications need it regardless of the mailbox
   choice, it is per-message (free at demo volume), and it is the outbound half
   of the self-host path. This is the one email piece worth doing immediately.
2. Add a `mail` app: Roundcube webmail chart, OIDC via Keycloak, in the portal
   nav next to Chat/Meet. Config takes IMAP/SMTP host + credentials so the
   backend provider is swappable.
3. For the demo user mailboxes: an Infomaniak (or mailbox.org) account + API
   token; a small provisioning step creating mailboxes for the demo users; DNS
   SPF/DKIM/DMARC for the demo domain pointed at the provider (+ the relay).
4. Document option B (Stalwart + EU relay) as the self-host path for operators
   who want the mailbox in-house, reusing the step-1 relay for outbound.
5. Track MinBZK PR #621 and `suitenumerique/messages`; revisit adopting La Suite
   Messages as the native mail app once it reaches 1.0 and/or adds IMAP.

## Sources

Upstream / La Suite:
- MinBZK tool selection (email: LaSuite messages | Open-Xchange): https://github.com/MinBZK/mijn-bureau-infra/issues/586
- MinBZK "Add email client to infra": https://github.com/MinBZK/mijn-bureau-infra/issues/98
- MinBZK draft PR "add email" (LaSuite Messages): https://github.com/MinBZK/mijn-bureau-infra/pull/621
- La Suite Messages: https://github.com/suitenumerique/messages
- La Suite messagerie (older OX-based track): https://github.com/suitenumerique/messagerie

Self-host engines / deliverability:
- Stalwart: https://stalw.art/ , https://stalw.art/docs/cluster/orchestration/kubernetes/
- Mailu: https://mailu.io/ ; Mailcow: https://mailcow.email/
- Roundcube + Keycloak OIDC: https://github.com/roundcube/roundcubemail-docker/issues/158
- Bulk-sender auth rules (2025): https://powerdmarc.com/bulk-email-sender-requirements/
- EU outbound relays (pay-per-message SES-alternatives): https://www.scaleway.com/en/transactional-email-tem/ (€0.25/1000, 300/mo free), https://www.sweego.io/pricing , https://www.mailjet.com/pricing/

Managed EU providers:
- Infomaniak: https://www.infomaniak.com/en/ksuite/service-mail , API https://developer.infomaniak.com/docs/api
- mailbox.org admin/reseller API: https://mailbox.org/en/product/admin/
- Open-Xchange for service providers: https://www.open-xchange.com/ox-app-suite-for-service-providers
- OVHcloud email + SecNumCloud: https://www.ovhcloud.com/en/emails/ , https://www.ovhcloud.com/en/compliance/secnumcloud/
- Migadu (flat-rate multi-domain): https://migadu.com
