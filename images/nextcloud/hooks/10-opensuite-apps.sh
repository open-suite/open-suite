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
#   - richdocuments: the pinned official NC34-compatible release containing
#     the upstream empty image-picker fix.
#   - whiteboard: the checksum-pinned official release. Its matching backend
#     designates the browser responsible for durable Nextcloud file writes.
set -eu
stage_root="${OPENSUITE_STAGE_ROOT:-/usr/src/opensuite}"
nextcloud_root="${NEXTCLOUD_ROOT:-/var/www/html}"
for app in meetcal user_oidc richdocuments whiteboard; do
  source="${stage_root}/${app}"
  if [ ! -d "${source}" ]; then
    echo "ERROR: image is missing required app source: ${app}" >&2
    exit 1
  fi
  rsync -a --delete "${source}/" "${nextcloud_root}/custom_apps/${app}/"
done
