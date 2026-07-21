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

if [ "${OPEN_SUITE_TLS_MODE:-letsencrypt}" = "selfsigned" ]; then
  DOMAIN="$(cat /etc/mijnbureau/domain 2>/dev/null || true)"
  if [ -z "${DOMAIN}" ]; then
    echo "ERROR: /etc/mijnbureau/domain is missing; cannot locate Keycloak's OIDC CA." >&2
    exit 1
  fi

  # Secrets cannot be mounted across namespaces. Mirror only the public CA
  # certificate (never the ingress private key) into Synapse's namespace so
  # its HTTPS OIDC client can retain certificate and hostname verification.
  ca_file="$(mktemp)"
  trap 'rm -f "${ca_file}"' EXIT
  if ! kubectl -n mb-keycloak get secret "id.${DOMAIN}-tls" \
      -o jsonpath='{.data.ca\.crt}' | base64 -d > "${ca_file}" \
      || [ ! -s "${ca_file}" ] \
      || ! openssl x509 -in "${ca_file}" -noout -checkend 0 >/dev/null 2>&1; then
    echo "ERROR: Keycloak self-signed OIDC CA is absent, empty, expired, or malformed." >&2
    exit 1
  fi
  kubectl -n mb-element create configmap synapse-keycloak-oidc-ca \
    --from-file=ca.crt="${ca_file}" --dry-run=client -o yaml \
    | kubectl apply -f -
fi

echo "==> [6h] Restarting OIDC apps so they re-read discovery"
kubectl rollout restart deploy/grist -n mb-grist
kubectl rollout restart deploy/docs-backend -n mb-docs
kubectl rollout restart deploy/nextcloud -n mb-nextcloud
kubectl rollout restart deploy/meet-backend -n mb-meet
kubectl rollout restart deploy/synapse -n mb-element
kubectl rollout status deploy/synapse -n mb-element --timeout=300s

echo ""
echo "Applied. Give the pods ~1-2 minutes, then retry logging in."
