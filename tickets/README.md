# Tickets

One file per ticket, derived from FABLE-PLAN (itself derived from FABLE-REVIEW). Numbering matches the plan.

Rules for the executing agent:

- One ticket = one branch = one PR-sized change. Do not bundle tickets.
- If a ticket's premise turns out false on inspection, stop and report rather than improvise.
- PRs on `open-suite/*` repos may be opened without asking; anything touching the live server (95.217.109.206) must be reported before and after.
- Each ticket lists `Touches` (files it edits) and `Conflicts with` (tickets sharing those files). Two tickets that conflict must not be worked in parallel — pick one, land it, rebase the other.

## Parallelization waves

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
