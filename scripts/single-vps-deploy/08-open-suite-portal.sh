#!/usr/bin/env bash
# Usage: ./08-open-suite-portal.sh
# Open Suite portal layer on top of the MinBZK base (scripts 01-04):
#   - points the portal deployments at our prebuilt fork images (built and
#     published to GHCR by open-suite-portal's publish-images workflow)
#   - installs the Nextcloud apps (calendar, deck, contacts)
#   - wires the portal's calendar to Nextcloud CalDAV
#
# The portal source is our detached fork open-suite/open-suite-portal. Nothing
# is built on the box; both images are tagged with the short SHA of
# PORTAL_REF, so bumping the pin selects the matching images.
#
# Idempotent and safe to re-run. Reads the domain from /etc/mijnbureau/domain.
set -euo pipefail

# Pinned SHA of open-suite-portal main (bump deliberately, not implicitly).
PORTAL_REF="${PORTAL_REF:-54795b661cb9c60938d0e6e7a15418ee6e0bbd86}"
FRONTEND_IMAGE="${FRONTEND_IMAGE:-ghcr.io/open-suite/portal-frontend:sha-${PORTAL_REF:0:7}}"
# portal-api is an overlay on the pinned upstream MinBZK image (see the fork's
# backend/Dockerfile.overlay) — upstream uv.lock drift blocks a source build.
API_IMAGE="${API_IMAGE:-ghcr.io/open-suite/portal-api:sha-${PORTAL_REF:0:7}}"

export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
DOMAIN="$(cat /etc/mijnbureau/domain)"

echo "==> [1/3] Pointing portal deployments at ${API_IMAGE} / ${FRONTEND_IMAGE}"
kubectl -n mb-bureaublad patch deploy bureaublad-backend --type=json -p="[
  {\"op\":\"replace\",\"path\":\"/spec/template/spec/containers/0/image\",\"value\":\"${API_IMAGE}\"},
  {\"op\":\"replace\",\"path\":\"/spec/template/spec/containers/0/imagePullPolicy\",\"value\":\"IfNotPresent\"}]"
kubectl -n mb-bureaublad patch deploy bureaublad-frontend --type=json -p="[
  {\"op\":\"replace\",\"path\":\"/spec/template/spec/containers/0/image\",\"value\":\"${FRONTEND_IMAGE}\"},
  {\"op\":\"replace\",\"path\":\"/spec/template/spec/containers/0/imagePullPolicy\",\"value\":\"IfNotPresent\"}]"

echo "==> [2/3] Installing the Nextcloud apps (calendar, deck, contacts)"
# deck backs the "Projects" claim on the landing page; contacts backs the
# people/invite flows. install fails if already installed, then enable is
# the no-op-safe fallback.
for app in calendar deck contacts; do
  kubectl -n mb-nextcloud exec deploy/nextcloud -c nextcloud -- \
    sh -c "cd /var/www/html && (php occ app:install $app || php occ app:enable $app)"
done

echo "==> [3/3] Wiring the portal calendar to Nextcloud CalDAV"
kubectl -n mb-bureaublad set env deploy/bureaublad-backend \
  CALENDAR_URL="https://nextcloud.${DOMAIN}/apps/calendar" \
  CALENDAR_CARD=true \
  TASK_URL="https://nextcloud.${DOMAIN}" \
  TASK_AUDIENCE=nextcloud

kubectl -n mb-bureaublad rollout status deploy/bureaublad-backend --timeout=180s
kubectl -n mb-bureaublad rollout status deploy/bureaublad-frontend --timeout=180s

echo ""
echo "Open Suite portal + calendar live at https://bridge.${DOMAIN}"
