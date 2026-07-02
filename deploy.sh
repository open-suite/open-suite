#!/usr/bin/env bash
# Usage: sudo ./deploy.sh <domain> <email> <master-password>
#
# Single happy-path deploy for open-suite on a fresh Ubuntu 24.04 VPS (k3s).
# Runs the MinBZK base (01-04: helmfile + patches, networking, cert wait,
# restarts, office cache) then the Open Suite layer (08-13: portal, header,
# login theme, Element, auth gate, Meet). Gaps in the numbering are steps
# made declarative and deleted (ticket 3.4). Final URL: https://bridge.DOMAIN
#
# Run this from a checkout of the open-suite repo on the target VPS, as root.
# Every step is idempotent, so re-running is safe.
set -euo pipefail

DOMAIN="${1:?Usage: $0 <domain> <email> <master-password>}"
EMAIL="${2:?Usage: $0 <domain> <email> <master-password>}"
MASTER_PASSWORD="${3:?Usage: $0 <domain> <email> <master-password>}"
OPEN_SUITE_DEMO_MODE="${OPEN_SUITE_DEMO_MODE:-false}"
OPEN_SUITE_DEMO_USERNAME="${OPEN_SUITE_DEMO_USERNAME:-johndoe}"
OPEN_SUITE_DEMO_PASSWORD="${OPEN_SUITE_DEMO_PASSWORD:-myStrongPassword123}"
# No fallback to MASTER_PASSWORD: when the admin password is unset, 01-deploy.sh
# generates one and the login page never shows admin credentials.
OPEN_SUITE_DEMO_ADMIN_USERNAME="${OPEN_SUITE_DEMO_ADMIN_USERNAME:-demoadmin}"
OPEN_SUITE_DEMO_ADMIN_PASSWORD="${OPEN_SUITE_DEMO_ADMIN_PASSWORD:-}"
export OPEN_SUITE_DEMO_MODE OPEN_SUITE_DEMO_USERNAME OPEN_SUITE_DEMO_PASSWORD
export OPEN_SUITE_DEMO_ADMIN_USERNAME OPEN_SUITE_DEMO_ADMIN_PASSWORD

DIR="$(cd "$(dirname "$0")/scripts/single-vps-deploy" && pwd)"
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

wait_for_certs() {
  echo "==> Waiting for TLS certificates"
  sleep 30
  # Bounded: 80 iterations x 15s = 20 minutes, far beyond a healthy Let's
  # Encrypt issuance. Timing out means DNS/ingress/issuer is broken — fail
  # loudly instead of polling forever.
  local prev=-1 stable=0 total ready i
  for i in $(seq 1 80); do
    total=$(kubectl get certificate -A --no-headers 2>/dev/null | wc -l | tr -d ' ')
    ready=$(kubectl get certificate -A --no-headers 2>/dev/null | awk '$3=="True"' | wc -l | tr -d ' ')
    echo "  certificates ready: ${ready}/${total}"
    if [ "${total}" -gt 0 ] && [ "${total}" -eq "${ready}" ]; then
      if [ "${total}" -eq "${prev}" ]; then stable=$((stable + 1)); [ "${stable}" -ge 2 ] && return 0
      else stable=0; fi
    else stable=0; fi
    prev="${total}"; sleep 15
  done
  echo "ERROR: certificates not all ready after 20 minutes." >&2
  echo "Check: kubectl get certificate -A; kubectl describe clusterissuer letsencrypt-prod;" >&2
  echo "DNS for *.${DOMAIN} must point at this box and port 80/443 must be reachable." >&2
  return 1
}

bash "${DIR}/01-deploy.sh"            "${DOMAIN}" "${EMAIL}" "${MASTER_PASSWORD}"
bash "${DIR}/02-networking.sh"        "${DOMAIN}"
wait_for_certs
bash "${DIR}/03-restart-oidc-apps.sh"
bash "${DIR}/04-nextcloud-office.sh"
bash "${DIR}/08-open-suite-portal.sh"
bash "${DIR}/09-portal-header.sh"
bash "${DIR}/10-keycloak-login.sh"
bash "${DIR}/11-element-web.sh"
bash "${DIR}/12-auth-gate.sh"
bash "${DIR}/13-meet-frontend.sh"

echo ""
echo "############################################################"
echo "# Open Suite deployed: https://bridge.${DOMAIN}"
echo "############################################################"
