#!/usr/bin/env bash
# Usage: ./13-meet-frontend.sh
# Points the Meet frontend deployment at the Open Suite-patched image built by
# CI (.github/workflows/meet-frontend-image.yaml: upstream at the pinned ref +
# patches/meet/*). Override MEET_IMAGE to pin a different tag/digest.
set -euo pipefail

MEET_IMAGE="${MEET_IMAGE:-ghcr.io/open-suite/meet-frontend:v1.20.0}"

export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

echo "==> [1/2] Pointing Meet frontend deployment at ${MEET_IMAGE}"
kubectl -n mb-meet patch deploy meet-frontend --type=json -p="[
  {\"op\":\"replace\",\"path\":\"/spec/template/spec/containers/0/image\",\"value\":\"${MEET_IMAGE}\"},
  {\"op\":\"replace\",\"path\":\"/spec/template/spec/containers/0/imagePullPolicy\",\"value\":\"Always\"},
  {\"op\":\"replace\",\"path\":\"/spec/template/spec/initContainers/0/image\",\"value\":\"${MEET_IMAGE}\"},
  {\"op\":\"replace\",\"path\":\"/spec/template/spec/initContainers/0/imagePullPolicy\",\"value\":\"Always\"}]"

# The tag is re-pushed when patches/meet/* change, so force a pull+restart to
# converge on the current build even when the tag string is unchanged.
echo "==> [2/2] Rolling the deployment"
kubectl -n mb-meet rollout restart deploy/meet-frontend
kubectl -n mb-meet rollout status deploy/meet-frontend --timeout=180s

echo ""
echo "Open Suite Meet frontend live."
