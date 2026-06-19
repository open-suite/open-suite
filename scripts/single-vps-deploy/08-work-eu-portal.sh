#!/usr/bin/env bash
# Usage: ./08-work-eu-portal.sh
# Keep Office portal layer on top of the MinBZK base (scripts 01-07):
#   - builds our Keep Office portal backend (CalDAV fixes) and frontend
#     (Keep Office branding + upcoming-events Calendar widget) from our fork
#   - installs the Nextcloud Calendar app
#   - wires the portal's calendar to Nextcloud CalDAV
#
# The portal source is our detached fork Keep-Office/keep-office-portal, which
# already carries the changes that used to live in overlays/bureaublad.
#
# Idempotent and safe to re-run. Reads the domain from /etc/mijnbureau/domain.
set -euo pipefail

PORTAL_REPO="${PORTAL_REPO:-https://github.com/Keep-Office/keep-office-portal}"
PORTAL_REF="${PORTAL_REF:-main}"
# Base image for the backend: pinned upstream API so we only override the one
# patched file and avoid lockfile drift from a full source build.
BACKEND_BASE_IMAGE="${BACKEND_BASE_IMAGE:-ghcr.io/minbzk/bureaublad-api:v0.9.3}"
BUILDX_VERSION="${BUILDX_VERSION:-v0.19.3}"

export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
DOMAIN="$(cat /etc/mijnbureau/domain)"

echo "==> [1/7] Ensuring docker buildx is available"
if ! docker buildx version >/dev/null 2>&1; then
  mkdir -p ~/.docker/cli-plugins
  curl -fsSL "https://github.com/docker/buildx/releases/download/${BUILDX_VERSION}/buildx-${BUILDX_VERSION}.linux-amd64" \
    -o ~/.docker/cli-plugins/docker-buildx
  chmod +x ~/.docker/cli-plugins/docker-buildx
fi

echo "==> [2/7] Fetching Keep Office portal source (${PORTAL_REPO}@${PORTAL_REF})"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
git clone --depth 1 --branch "${PORTAL_REF}" "${PORTAL_REPO}" "${WORK}/portal"

echo "==> [3/7] Building backend image (overlay on ${BACKEND_BASE_IMAGE} to avoid lockfile drift)"
cat > "${WORK}/Dockerfile.backend" <<EOF
FROM ${BACKEND_BASE_IMAGE}
COPY backend/app/clients/caldav.py /app/app/clients/caldav.py
EOF
docker buildx build --load -f "${WORK}/Dockerfile.backend" -t keep-office/portal-api:local "${WORK}/portal"
docker save keep-office/portal-api:local | k3s ctr -n k8s.io images import -

echo "==> [4/7] Building frontend image from our fork"
docker buildx build --load -t keep-office/portal-frontend:local "${WORK}/portal/frontend"
docker save keep-office/portal-frontend:local | k3s ctr -n k8s.io images import -

echo "==> [5/7] Pointing portal deployments at our images"
kubectl -n mb-bureaublad patch deploy bureaublad-backend --type=json -p='[
  {"op":"replace","path":"/spec/template/spec/containers/0/image","value":"keep-office/portal-api:local"},
  {"op":"replace","path":"/spec/template/spec/containers/0/imagePullPolicy","value":"Never"}]'
kubectl -n mb-bureaublad patch deploy bureaublad-frontend --type=json -p='[
  {"op":"replace","path":"/spec/template/spec/containers/0/image","value":"keep-office/portal-frontend:local"},
  {"op":"replace","path":"/spec/template/spec/containers/0/imagePullPolicy","value":"Never"}]'

echo "==> [6/7] Installing the Nextcloud Calendar app"
kubectl -n mb-nextcloud exec deploy/nextcloud -c nextcloud -- \
  sh -c "cd /var/www/html && (php occ app:install calendar || php occ app:enable calendar)"

echo "==> [7/7] Wiring the portal calendar to Nextcloud CalDAV"
kubectl -n mb-bureaublad set env deploy/bureaublad-backend \
  CALENDAR_URL="https://nextcloud.${DOMAIN}/apps/calendar" \
  CALENDAR_CARD=true \
  TASK_URL="https://nextcloud.${DOMAIN}" \
  TASK_AUDIENCE=nextcloud

kubectl -n mb-bureaublad rollout status deploy/bureaublad-backend --timeout=120s
kubectl -n mb-bureaublad rollout status deploy/bureaublad-frontend --timeout=180s

echo ""
echo "Keep Office portal + calendar live at https://bridge.${DOMAIN}"
