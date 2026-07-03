#!/bin/sh
# Runs from /docker-entrypoint-hooks.d/before-starting/ on every container
# start, before Apache/PHP serve anything (so opcache, which we run with
# validate_timestamps=0, always caches the current code).
#
# custom_apps lives on the PVC; the image stages our apps under
# /usr/src/opensuite and this hook syncs them over the PVC copies:
#   - meetcal: our Calendar<->Meet app (source of truth: images/nextcloud/)
#   - user_oidc: the pinned upstream release with the token-exchange fix
#     (requested_token_type refresh->access, required by Keycloak 26 standard
#     exchange; see images/nextcloud/patches/). occ app:install in the chart's
#     post-install script is a no-op once this copy exists.
set -eu
for app in meetcal user_oidc; do
  if [ -d "/usr/src/opensuite/${app}" ]; then
    rsync -a --delete "/usr/src/opensuite/${app}/" "/var/www/html/custom_apps/${app}/"
  fi
done
