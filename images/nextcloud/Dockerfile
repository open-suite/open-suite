# Open Suite Nextcloud: the pinned upstream image plus our apps baked in
# (ticket 3.3). The build context must contain a patched user_oidc/ tree —
# the CI workflow downloads the pinned release tarball and applies
# patches/user-oidc-token-exchange-access-token.patch before building.
ARG NEXTCLOUD_BASE=registry-1.docker.io/library/nextcloud:34.0.0-apache
FROM ${NEXTCLOUD_BASE}
COPY meetcal/ /usr/src/opensuite/meetcal/
COPY user_oidc/ /usr/src/opensuite/user_oidc/
COPY hooks/10-opensuite-apps.sh /usr/local/bin/opensuite-sync-apps
# The upstream entrypoint runs post-installation after pre-installation, and
# `occ upgrade` after pre-upgrade. Put our baked app code in place before both;
# before-starting remains the same-version image-update/restart fallback.
RUN chmod +x /usr/local/bin/opensuite-sync-apps \
 && for phase in pre-installation pre-upgrade before-starting; do \
      ln -s /usr/local/bin/opensuite-sync-apps \
        "/docker-entrypoint-hooks.d/${phase}/10-opensuite-apps.sh"; \
      test "$(readlink "/docker-entrypoint-hooks.d/${phase}/10-opensuite-apps.sh")" \
        = /usr/local/bin/opensuite-sync-apps; \
    done
