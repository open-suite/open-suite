#!/usr/bin/env bash
# Usage: ./12-meet-frontend.sh
# Builds the Open Suite-patched La Suite Meet frontend and points the live
# frontend deployment at it.
set -euo pipefail

MEET_REPO="${MEET_REPO:-https://github.com/suitenumerique/meet.git}"
MEET_REF="${MEET_REF:-v1.20.0}"
BUILDX_VERSION="${BUILDX_VERSION:-v0.19.3}"

export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

echo "==> [1/5] Ensuring docker buildx is available"
if ! docker buildx version >/dev/null 2>&1; then
  mkdir -p ~/.docker/cli-plugins
  curl -fsSL "https://github.com/docker/buildx/releases/download/${BUILDX_VERSION}/buildx-${BUILDX_VERSION}.linux-amd64" \
    -o ~/.docker/cli-plugins/docker-buildx
  chmod +x ~/.docker/cli-plugins/docker-buildx
fi

echo "==> [2/5] Fetching Meet source (${MEET_REPO}@${MEET_REF})"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
git clone --depth 1 --branch "${MEET_REF}" "${MEET_REPO}" "${WORK}/meet"

echo "==> [3/5] Applying Open Suite Meet frontend patches"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
for p in "${REPO_ROOT}"/patches/meet/*.patch; do
  [ -e "$p" ] || continue
  echo "==> Applying Meet patch: $(basename "$p")"
  git -C "${WORK}/meet" apply "$p"
done

echo "==> [4/5] Building patched Meet frontend image"
docker buildx build --load \
  -f "${WORK}/meet/src/frontend/Dockerfile" \
  --target frontend-production \
  --build-arg DOCKER_USER=101 \
  -t open-suite/meet-frontend:local \
  "${WORK}/meet"
docker save open-suite/meet-frontend:local | k3s ctr -n k8s.io images import -

echo "==> [5/5] Pointing Meet frontend deployment at patched image"
kubectl -n mb-meet patch deploy meet-frontend --type=json -p='[
  {"op":"replace","path":"/spec/template/spec/containers/0/image","value":"open-suite/meet-frontend:local"},
  {"op":"replace","path":"/spec/template/spec/containers/0/imagePullPolicy","value":"Never"},
  {"op":"replace","path":"/spec/template/spec/initContainers/0/image","value":"open-suite/meet-frontend:local"},
  {"op":"replace","path":"/spec/template/spec/initContainers/0/imagePullPolicy","value":"Never"}]'

kubectl -n mb-meet rollout restart deploy/meet-frontend
kubectl -n mb-meet rollout status deploy/meet-frontend --timeout=180s

echo ""
echo "Open Suite Meet frontend live."
