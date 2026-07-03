# Open Suite Nextcloud image

Pinned upstream Nextcloud plus:

- `meetcal/` — our Calendar ↔ Meet Nextcloud app (real, lintable source; the
  helm patch only `occ app:enable`s it).
- `user_oidc` at a pinned release with
  `patches/user-oidc-token-exchange-access-token.patch` applied at build time
  (Keycloak 26 standard token exchange rejects
  `requested_token_type=refresh_token`; Meet only needs the access token).
  Upstream PR: (pending — see ticket 3.3).
- `hooks/10-opensuite-apps.sh` — syncs both apps from the image onto the
  custom_apps PVC on every container start, so upgrades and opcache
  (`validate_timestamps=0`) always see current code.

Built and pushed to `ghcr.io/open-suite/nextcloud` by
`.github/workflows/nextcloud-image.yaml` (tags: the upstream base tag, and
`sha-<commit>`); `user_oidc/` is fetched in CI, never committed here.
