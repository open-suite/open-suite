#!/usr/bin/env bash
# Usage: ./03-restart-oidc-apps.sh
# Restart the OIDC apps. Safe to run repeatedly — a rollout restart is
# idempotent.
#
# Each app fetches Keycloak's OIDC discovery document at startup. The first
# attempt happens before step 5's networking and the TLS certs are in place,
# so it fails — and that failure is sticky until the pod restarts. Restart
# them once the path works.
#
# The Nextcloud networking config that used to live here (SSRF guard
# allow_local_remote_servers, pod-subnet trusted_proxies) is declarative now:
# patches/local/nextcloud-networking.patch bakes both into the chart values,
# so helmfile apply alone produces them.
#
# Run this only once `kubectl get certificate -A` shows every cert READY=True.
set -euo pipefail

export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

echo "==> [6h] Restarting OIDC apps so they re-read discovery"
kubectl rollout restart deploy/grist -n mb-grist
kubectl rollout restart deploy/docs-backend -n mb-docs
kubectl rollout restart deploy/nextcloud -n mb-nextcloud
kubectl rollout restart deploy/meet-backend -n mb-meet
kubectl rollout restart deploy/synapse -n mb-element

echo ""
echo "Applied. Give the pods ~1-2 minutes, then retry logging in."
