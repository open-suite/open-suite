# Open Suite Nextcloud: the pinned upstream image plus our apps baked in
# (ticket 3.3). The build context must contain a patched user_oidc/ tree —
# the CI workflow downloads the pinned release tarball and applies
# patches/user-oidc-token-exchange-access-token.patch before building.
ARG NEXTCLOUD_BASE=registry-1.docker.io/library/nextcloud:34.0.0-apache
FROM ${NEXTCLOUD_BASE}
COPY meetcal/ /usr/src/opensuite/meetcal/
COPY user_oidc/ /usr/src/opensuite/user_oidc/
COPY hooks/10-opensuite-apps.sh /docker-entrypoint-hooks.d/before-starting/10-opensuite-apps.sh
RUN chmod +x /docker-entrypoint-hooks.d/before-starting/10-opensuite-apps.sh
