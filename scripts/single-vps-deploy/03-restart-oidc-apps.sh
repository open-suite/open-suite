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

# Step 02 restarts CoreDNS, and Traefik can still be converging after the
# initial Helmfile apply. Synapse caches an OIDC preload failure, so do not
# restart it until the complete HTTPS hairpin path is ready.
kubectl rollout status deploy/coredns -n kube-system --timeout=300s
kubectl rollout status deploy/traefik -n kube-system --timeout=300s

if [ "${OPEN_SUITE_TLS_MODE:-letsencrypt}" = "selfsigned" ]; then
  # Read the mirrored CA from the volume Synapse will use and exercise the
  # complete in-cluster DNS -> Traefik -> Keycloak path before restarting.
  # Provider preload is not retried after startup, so Kubernetes readiness is
  # insufficient here: fail closed unless a verified JWKS response arrives.
  jwks_ready=false
  for attempt in $(seq 1 30); do
    synapse_pod="$(kubectl -n mb-element get pod \
      -l 'app.kubernetes.io/name=synapse,app.kubernetes.io/instance=synapse' \
      --field-selector=status.phase=Running \
      -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
    if [ -n "${synapse_pod}" ] && timeout --signal=TERM --kill-after=5s 15s \
        kubectl -n mb-element exec "${synapse_pod}" -c synapse -- \
          python - "${DOMAIN}" <<'PY'
import json
import ssl
import sys
import urllib.request

domain = sys.argv[1]
url = f"https://id.{domain}/realms/mijnbureau/protocol/openid-connect/certs"
context = ssl.create_default_context(cafile="/synapse/oidc-ca/ca.crt")
with urllib.request.urlopen(url, context=context, timeout=10) as response:
    jwks = json.load(response)
if not jwks.get("keys"):
    raise SystemExit("Keycloak returned no OIDC signing keys")
PY
    then
      jwks_ready=true
      echo "==> Verified Synapse OIDC JWKS over HTTPS using the mirrored CA"
      break
    fi
    echo "  Verified Synapse OIDC JWKS path not ready (${attempt}/30); retrying in 5 seconds"
    [ "${attempt}" = 30 ] || sleep 5
  done
  if [ "${jwks_ready}" != true ]; then
    echo "ERROR: Synapse could not fetch Keycloak JWKS over verified HTTPS after bounded retries." >&2
    kubectl get deploy,pod,svc,endpoints -n mb-keycloak -o wide >&2 || true
    kubectl get deploy,pod -n kube-system -l app.kubernetes.io/name=traefik -o wide >&2 || true
    exit 1
  fi
fi

echo "==> [6h] Restarting OIDC apps so they re-read discovery"
kubectl rollout restart deploy/grist -n mb-grist
kubectl rollout restart deploy/docs-backend -n mb-docs
kubectl rollout restart deploy/nextcloud -n mb-nextcloud
kubectl rollout restart deploy/meet-backend -n mb-meet
mapfile -t synapse_deployments < <(kubectl -n mb-element get deployment \
  -l 'app.kubernetes.io/name=synapse,app.kubernetes.io/instance=synapse' -o name)
if [ "${#synapse_deployments[@]}" -eq 0 ]; then
  echo "ERROR: no Synapse deployments matched the chart labels." >&2
  exit 1
fi
for deployment in "${synapse_deployments[@]}"; do
  kubectl -n mb-element rollout restart "${deployment}"
done
for deployment in "${synapse_deployments[@]}"; do
  kubectl -n mb-element rollout status "${deployment}" --timeout=300s
done

echo ""
echo "Applied. Give the pods ~1-2 minutes, then retry logging in."
