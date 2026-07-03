#!/usr/bin/env bash
# Usage: ./08-open-suite-portal.sh
# Open Suite portal layer on top of the MinBZK base (scripts 01-04):
# installs the Nextcloud apps (calendar, deck, contacts).
#
# Everything else that used to live here is declarative now:
#   - portal images: container.bureaublad.* in the demo values (01-deploy.sh),
#     pinned to PORTAL_REF, so helmfile owns them and a re-apply cannot revert
#     the portal to upstream images
#   - calendar/tasks env wiring: patches/local/bureaublad-calendar-env.patch
#
# Idempotent and safe to re-run.
set -euo pipefail

export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

echo "==> Installing the Nextcloud apps (calendar, deck, contacts)"
# deck backs the "Projects" claim on the landing page; contacts backs the
# people/invite flows. install fails if already installed, then enable is
# the no-op-safe fallback.
for app in calendar deck contacts; do
  kubectl -n mb-nextcloud exec deploy/nextcloud -c nextcloud -- \
    sh -c "cd /var/www/html && (php occ app:install $app || php occ app:enable $app)"
done

echo "Done. Portal images and calendar wiring are owned by helmfile (01)."
