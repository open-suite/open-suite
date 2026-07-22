#!/bin/sh
# Runs from the upstream entrypoint's pre-installation, pre-upgrade, and
# before-starting phases. The early phases ensure chart post-install commands
# and required database migrations see the image's app versions. The final
# phase covers restarts and app-only image changes where the core version did
# not trigger either early phase, before Apache/PHP can cache old code.
#
# custom_apps lives on the PVC; the image stages our apps under
# /usr/src/opensuite and this hook syncs them over the PVC copies:
#   - meetcal: our Calendar<->Meet app (source of truth: images/nextcloud/)
#   - user_oidc: the pinned upstream release with the token-exchange fix
#     (requested_token_type refresh->access, required by Keycloak 26 standard
#     exchange; see images/nextcloud/patches/). occ app:install in the chart's
#     post-install script becomes a local enable once this copy exists.
#   - whiteboard: the checksum-pinned official release. Its matching backend
#     designates the browser responsible for durable Nextcloud file writes.
set -eu
for app in meetcal user_oidc whiteboard; do
  source="/usr/src/opensuite/${app}"
  if [ ! -d "${source}" ]; then
    echo "ERROR: image is missing required app source: ${app}" >&2
    exit 1
  fi
  rsync -a --delete "${source}/" "/var/www/html/custom_apps/${app}/"
done
