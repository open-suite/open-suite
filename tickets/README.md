# Tickets

One file per ticket, derived from FABLE-PLAN (itself derived from FABLE-REVIEW). Numbering matches the plan.

## Status ledger (updated 2026-07-02)

Done and merged: 0.1 (#29), 0.2+0.3 (#30), 0.4 (#31), 1.1 (#32), 1.2 (#40), 1.3 (#41), 1.4 (#33), 1.5 (portal #20, already on main), 1.6 (#34), 1.7 (verified: all four PRs #24–27 merged, Meet patch applies at v1.20.0, scripts renumbered — 12 auth-gate, 13 meet-frontend), 2.1 (#37), 2.2 (#35), 2.4 (#36), 2.5 (portal #25), 2.6 (#39), 3.4 (#46–#50 — one PR per script; 03/05/06/07 mutations now patches/values, 12's annotate step gone; plus fixes #51 meetcal cronjob volume, #52 occ container), 4.4 (docs #1), 4.1 (#54), 4.2 (#56 + outer CLAUDE.md edited in place), 4.3 (#55), 4.5 (#57), 4.6 (branch sweep, see ticket), 3.1 (#43, #61, #62, portal #11/#26 — zero on-box builds, verified live 2026-07-03), 3.2 (portal #26 + #62), 3.5 (#64/#67/#69/#70 + live 2026-07-03 — helmfile owns the sidecar; a re-apply keeps the header, verified by the authenticated smoke), 3.6 scripts (#65), 3.3 (#74 — verified live 2026-07-03: pod runs ghcr.io/open-suite/nextcloud, TokenService has zero refresh_token requests, no NoCSRFRequired, meetcal mints rooms with CSRF enforced, both smokes green).

Partial / blocked — read the ticket file's "Status" footer before picking up:
- 2.3 — blocked, premise false. meetcal endpoint needs an interactive OIDC session; app-password calls get 401 no_token. Options recorded on ticket. No further work unless the approach changes.

All tickets done. 3.6 CI (#76): both smoke suites run in Actions against the live demo (main pushes, nightly 05:17 UTC, dispatch; SMOKE_PASS secret set; first runs green) — a fresh-VM deploy test doesn't fit free runners (4 vCPU/16 GB vs 12/48 + real DNS for certs), planned for an ephemeral Hetzner VM later. 3.3's user_oidc fix is carried as our local build-time patch; the upstream contribution to nextcloud/user_oidc is deferred until reviewed and explicitly approved.

Phase 2 — closing the redeploy-revert holes 2026-07-08. Two of the three imperative fixes a bare `helmfile apply` reverted are now declarative. 2.1 (#124): the Keycloak login theme was mounted by a `kubectl patch sts` in step 10 while the realm's loginTheme:opensuite was declarative — a re-apply dropped the mount and left a themeless login page. Moved the volume + mount into the keycloak chart values (`keycloak-login-theme-mount.patch`, top-level extraVolumes/extraVolumeMounts); step 10 now only ships the configmap (unmanaged by helm, survives apply) and restarts. Verified by `helmfile -e demo template`. 2.2 (#125): Element's verification-reminder toasts were patched out of the bundle by a runtime initContainer (11-element-web.sh) that a re-apply reverted. Baked the same edit into `ghcr.io/open-suite/element-web` at build time (`images/element/`), pinned as `container.elementweb`, deleted step 11. Build-time script keeps step 11's grep pre/post assertions so a bundle drift fails the build; verified it builds against v1.12.21 locally. Neither was live-applied — the live demo already carries both via the old imperative mounts; convergence validation is a maintenance-window job (`ci/convergence-check.sh`, its probes updated). Remaining Phase 2 holes: 2.3 (static-SPA header for Meet/Element — Meet also has no nav at all right now) and 2.4 (auth-gate manifests into helmfile).

Phase 1 — green means working 2026-07-08 (#122): the smoke suite reported green all through the recovery incident while the demo was broken, because it only checked that widgets render, not that they hold data. Fixed: the authenticated smoke now asserts seeded content (calendar Team standup event AND that it is upcoming — a dead seed leaves it in the past; docs widget lists seeded docs; meet widget lists rooms; Element carries the Open Suite nav via bureaublad-button.js). A silently-dead seed now turns CI red. Added `ci/convergence-check.sh` — a box-side maintenance-window runbook that snapshots the known imperative fixes (Keycloak theme mount, Element bundle initContainer, Meet/Element static-header configmap keys), runs a bare `helmfile -e demo apply`, reports which reverted (the Phase 2 debt), then heals via the imperative deploy steps and re-checks; not run yet (needs a window — it degrades the demo mid-run). Smoke workflow got a `concurrency: smoke-live-demo` group so two overlapping runs can't race each other's document cleanup (the stray-file race noted in the recovery). Known gap deferred to Phase 2: Meet's served HTML omits the injected header button although `meet-static-files` carries it — the static-SPA header path (09 patch_static) is imperative and needs the ticket-3.5 declarative treatment; not asserted in the smoke yet.

Demo recovery 2026-07-07 (#114–#117): the demo had silently degraded again — three root causes, none caught by the smokes. (a) Collabora CODE 26.04 fetches `/apps/richdocuments/settings/...` server-to-server on every doc open; the gate's WOPI pass-through (#100) didn't cover it, so every document hung at "Connecting..." while the smoke's menubar check still passed (#114 widens the pass-through). (b) The seed cron had exited silently since Jul 4: the rebuild wiped the `demo-seed` secret and `set -e` killed the script inside the first assignment with no output — and even when re-run, its calendar PUTs bounced off the gate with a 302 that `curl -fsS` counts as success (#115 — loud abort on missing creds, WebDAV via the in-cluster service, 2xx asserted on every DAV call). (c) The smoke's own New→Document step left a file behind on every run — the 21 `Document (n).docx` copies were the smoke plus human retries against the hung editor (#117 cleans up after itself). Also #116: Collabora first-run welcome dialog off via `patches/local/collabora-no-welcome.patch` (which also fixes upstream's stray trailing quote in `extra_params` — upstreamable). Live surgery on the box: `demo-seed` secret recreated (app password minted via the browser session — CLI-minted app passwords fail for user_oidc users, "Session token credentials are invalid"), duplicates deleted, one kept as `Q3 planning notes.docx`, junk `lkj` event and stale activity rows purged, `trusted_proxies` 127.0.0.1 drift re-applied, gate pinned to `sha-78c0572` (was floating `:main`). Verified: full authenticated smoke green, widgets populated, document opens clean.

Post-rebuild product crawl 2026-07-05 (automated Playwright pass over every app surface): found and fixed four more silent breakages — Element dead behind the gated matrix API (#96, ungated + smoke check), client-side E2EE still default-on (#96/#97, element-web config via chart patch), the NextCloud widget 502 on empty activity feeds (portal #34), the Synapse SSO consent screen (#98/#99, sso.client_whitelist + smoke check), and Office documents failing to open — a three-layer WOPI break: the gate intercepted Collabora callbacks (#100 pass-through), the localhost sidecar hop was untrusted (#101), and the all-trusted forwarded chain resolved to 127.0.0.1 vs the pod-subnet allowlist (#102). The smoke now opens a real document in Collabora (#103–#106) — 12 checks, all green. Verified working end-to-end by driving the product: Office editing, Meet call with live media, calendar Meet-link, chat, all portal widgets.

Clean rebuild 2026-07-04: the demo box was wiped (k3s-uninstall + state) and redeployed from scratch with `deploy.sh` — the first true fresh run of the letsencrypt path. Completed end-to-end with zero failures (13/13 certs); both smoke suites pass. Two fresh-install-only bugs found and fixed: the chart's post-install `occ app:enable meetcal` races the image's custom_apps sync (#93 — 08 enables it late; upstream's bureaublad_button has the same race and is additionally incompatible with NC 34, left disabled), and the Nextcloud chart renders `extraConfigs` into the configmap but never mounts them (#94, upstreamable — `allow_local_remote_servers` silently missing on fresh installs, breaking every NC OIDC login). Also on 2026-07-03/04: local fresh-VM harness (`scripts/local-vm/up.sh`, Lima + sslip.io + `OPEN_SUITE_TLS_MODE=selfsigned`), multi-arch images (amd64+arm64; portal-api now built from source — upstream's arm64 image ships amd64 wheels), portal PRs #29–#33, open-suite #78–#94. Demo admin password was regenerated by the rebuild — read `/etc/mijnbureau/demo-admin-password` on the box.

Standing item resolved 2026-07-02: main was applied to the live demo box (scripts 01–04, 08–11, 13 from a fresh `/root/open-suite` checkout; helmfile apply converged all patches). This picked up the previously unapplied 0.1 / 0.2+0.3 / 2.1 / 2.6 plus all of 3.4. Verified live: grist HPA gone + 1 replica, realm lifetimes in the config-cli import, TRUSTED_PROXIES both subnets + `opensuite.config.php`, docs y-provider 80→4444 and the migrate job granting to `docs`, gate middleware on all target ingresses with Keycloak ungated, all apps 302 to the gate, zero unhealthy pods. Notes: 12-auth-gate.sh was skipped (GHCR package still private, live gate runs the node-local `:local` image with pullPolicy Never — running 12 would break it; 3.1 blocker unchanged); the 3.5 header sidecar survived the helm upgrade; a redundant crashlooping `synapse-keygen` job (couldn't reach the API server during the k3s restart window; signing-key secret already exists) was deleted.

Rules for the executing agent:

- One ticket = one branch = one PR-sized change. Do not bundle tickets.
- If a ticket's premise turns out false on inspection, stop and report rather than improvise.
- PRs on `open-suite/*` repos may be opened without asking; anything touching the live server (95.217.109.206) must be reported before and after.
- Each ticket lists `Touches` (files it edits) and `Conflicts with` (tickets sharing those files). Two tickets that conflict must not be worked in parallel — pick one, land it, rebase the other.

## Recommended next order (remaining work)

1. 3.4 — move script mutations into patches/values. Independent, several small PRs (one per script: 03, 05, 06, 07, 12-ingress-annotations). Deps (1.3) landed. No live apply needed to author; verification is a `helmfile apply` on the box.
2. Phase 4 docs, all independent and low-risk: 4.1 (README + deploy.sh header), 4.2 (both CLAUDE.mds), 4.3 (docs/PLAN.md status), 4.5 (landing page / Deck install), 4.6 (git hygiene sweep). Phase 1 is done so these describe the fixed state.
3. 3.2 / 3.3 / 3.6 and the rest of 3.1 — the heavy structural work. 3.2 (backend overlay in fork) needs the uv.lock fix first; 3.3 (meetcal image overlay) and 3.6 (smoke test) both want 3.1's registry images. Sequence: unblock GHCR visibility → finish 3.1 (portal + meet images) → 3.2 → 3.3 → 3.6.
4. 3.5 declarative half — chart-patch the sidecar; needs a demo maintenance window.

## Parallelization waves (original plan)

Tickets in the same wave touch disjoint files and can run concurrently.

| Wave | Tickets | Notes |
|---|---|---|
| 1 | 0.1, 0.2+0.3 (one branch), 0.4, 1.1, 1.4, 1.5, 1.6, 2.2, 2.4, 2.5, 3.5, 4.4 | 0.2 and 0.3 are both part of PR #27's branch — do them together |
| 2 | 1.2, 1.3, 1.7, 2.1, 2.3, 2.6, 4.6 | after their wave-1 dependencies land |
| 3 | 3.1, 3.4, 4.1, 4.2, 4.3, 4.5 | 3.4 is itself several PRs, one per script |
| 4 | 3.2, 3.3, 3.6 | need 3.1 (registry images) |

## Index

### Phase 0 — security
- [0.1 Demo admin password must not default to master password](0.1-demo-admin-password.md)
- [0.2 Close the auth-gate Bearer bypass](0.2-auth-gate-bearer-bypass.md)
- [0.3 Fix the auth-gate egress NetworkPolicy](0.3-auth-gate-egress-netpol.md)
- [0.4 Demo seed: remove client weakening and phantom token](0.4-demo-seed-hardening.md)

### Phase 1 — make the deploy true
- [1.1 Idempotent step 01](1.1-idempotent-step-01.md)
- [1.2 Pin the upstream infra ref](1.2-pin-upstream-ref.md)
- [1.3 Timeout the cert wait; check the kcadm PUT](1.3-cert-wait-kcadm.md)
- [1.4 Delete install.sh](1.4-delete-install-sh.md)
- [1.5 Merge the portal CI fix](1.5-portal-ci-fix.md)
- [1.6 Fix the stale org default](1.6-stale-org-default.md)
- [1.7 Land the open PRs](1.7-land-open-prs.md)

### Phase 2 — kill duplication and dead weight
- [2.1 One owner for Keycloak branding + theme](2.1-keycloak-branding-owner.md)
- [2.2 Remove dead Element config patch; pin bundle patch](2.2-element-patches.md)
- [2.3 Single implementation of Meet room creation](2.3-meet-room-single-impl.md)
- [2.4 Delete the runner patch and overlay](2.4-delete-runner-patch.md)
- [2.5 Delete stale fork Dockerfiles](2.5-delete-stale-dockerfiles.md)
- [2.6 Fix php-cache × meetcal opcache interaction](2.6-opcache-meetcal.md)

### Phase 3 — declarative migration
- [3.1 Registry images instead of node-local](3.1-registry-images.md)
- [3.2 Backend overlay lives in the fork](3.2-backend-overlay-in-fork.md)
- [3.3 meetcal as image overlay + user_oidc fix as real patch](3.3-meetcal-image-overlay.md)
- [3.4 Move script mutations into patches/values](3.4-scripts-to-declarative.md)
- [3.5 Header sidecar via patch, not kubectl surgery](3.5-header-sidecar-patch.md)
- [3.6 Assembled-stack smoke test](3.6-smoke-test.md)

### Phase 4 — documentation truth pass
- [4.1 README + deploy.sh header](4.1-readme-truth.md)
- [4.2 Both CLAUDE.mds](4.2-claude-mds.md)
- [4.3 PLAN.md status honesty](4.3-plan-md-status.md)
- [4.4 Public docs repo hygiene](4.4-docs-repo-hygiene.md)
- [4.5 Make the landing page true (Deck)](4.5-landing-page-deck.md)
- [4.6 Git hygiene sweep](4.6-git-hygiene.md)

Standing decisions (apply to all tickets): the auth gate stays but is a demo curtain, not a security boundary; registry is GHCR under the open-suite org; meetcal PHP source lives in this repo (`images/nextcloud/`), not the portal fork.
