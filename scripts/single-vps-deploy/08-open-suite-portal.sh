#!/usr/bin/env bash
# Usage: ./08-open-suite-portal.sh
# Open Suite portal layer on top of the MinBZK base (scripts 01-07):
#   - builds our Open Suite portal backend (CalDAV fixes) and frontend
#     (Open Suite branding + upcoming-events Calendar widget) from our fork
#   - installs the Nextcloud Calendar app
#   - wires the portal's calendar to Nextcloud CalDAV
#
# The portal source is our detached fork open-suite/open-suite-portal, which
# already carries the changes that used to live in overlays/bureaublad.
#
# Idempotent and safe to re-run. Reads the domain from /etc/mijnbureau/domain.
set -euo pipefail

PORTAL_REPO="${PORTAL_REPO:-https://github.com/open-suite/open-suite-portal}"
# Pinned SHA of open-suite-portal main (bump deliberately, not implicitly).
PORTAL_REF="${PORTAL_REF:-67c6685dd4ed6095e2ae339354e1ef3ac0d12983}"
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

echo "==> [2/7] Fetching Open Suite portal source (${PORTAL_REPO}@${PORTAL_REF})"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
# Full clone + checkout: works for SHAs, tags, and branches alike (--branch
# rejects SHAs, and GitHub refuses shallow fetches of bare commits).
git clone "${PORTAL_REPO}" "${WORK}/portal"
git -C "${WORK}/portal" checkout -q "${PORTAL_REF}"

echo "==> [3/7] Building backend image (overlay on ${BACKEND_BASE_IMAGE} to avoid lockfile drift)"
cat > "${WORK}/Dockerfile.backend" <<EOF
FROM ${BACKEND_BASE_IMAGE}
COPY backend/app/clients/caldav.py /app/app/clients/caldav.py
COPY backend/app/models/calendar.py /app/app/models/calendar.py
COPY backend/app/routes/caldav.py /app/app/routes/caldav.py
COPY backend/app/token_exchange.py /app/app/token_exchange.py
EOF
docker buildx build --load -f "${WORK}/Dockerfile.backend" -t open-suite/portal-api:local "${WORK}/portal"
docker save open-suite/portal-api:local | k3s ctr -n k8s.io images import -

echo "==> [4/7] Building frontend image from our fork"
docker buildx build --load -t open-suite/portal-frontend:local "${WORK}/portal/frontend"
docker save open-suite/portal-frontend:local | k3s ctr -n k8s.io images import -

echo "==> [5/7] Pointing portal deployments at our images"
kubectl -n mb-bureaublad patch deploy bureaublad-backend --type=json -p='[
  {"op":"replace","path":"/spec/template/spec/containers/0/image","value":"open-suite/portal-api:local"},
  {"op":"replace","path":"/spec/template/spec/containers/0/imagePullPolicy","value":"Never"}]'
kubectl -n mb-bureaublad patch deploy bureaublad-frontend --type=json -p='[
  {"op":"replace","path":"/spec/template/spec/containers/0/image","value":"open-suite/portal-frontend:local"},
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

# The image tag (:local) doesn't change between builds, so patching the deploy
# is a no-op and won't restart the pods onto the freshly-imported image. Force
# a restart so the new build is actually picked up.
kubectl -n mb-bureaublad rollout restart deploy/bureaublad-backend deploy/bureaublad-frontend

kubectl -n mb-bureaublad rollout status deploy/bureaublad-backend --timeout=120s
kubectl -n mb-bureaublad rollout status deploy/bureaublad-frontend --timeout=180s

echo ""
echo "Open Suite portal + calendar live at https://bridge.${DOMAIN}"
