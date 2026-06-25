#!/usr/bin/env bash
# Usage: sudo ./deploy.sh <domain> <email> <master-password>
#
# Single happy-path deploy for open-suite on a fresh Ubuntu 24.04 VPS (k3s).
# Runs the MinBZK base stack (scripts 01-07) then the open-suite layer (08):
# patched portal + Nextcloud calendar wiring.
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
OPEN_SUITE_DEMO_ADMIN_USERNAME="${OPEN_SUITE_DEMO_ADMIN_USERNAME:-admin}"
OPEN_SUITE_DEMO_ADMIN_PASSWORD="${OPEN_SUITE_DEMO_ADMIN_PASSWORD:-${MASTER_PASSWORD}}"
export OPEN_SUITE_DEMO_MODE OPEN_SUITE_DEMO_USERNAME OPEN_SUITE_DEMO_PASSWORD
export OPEN_SUITE_DEMO_ADMIN_USERNAME OPEN_SUITE_DEMO_ADMIN_PASSWORD

DIR="$(cd "$(dirname "$0")/scripts/single-vps-deploy" && pwd)"
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

wait_for_certs() {
  echo "==> Waiting for TLS certificates"
  sleep 30
  local prev=-1 stable=0 total ready
  while :; do
    total=$(kubectl get certificate -A --no-headers 2>/dev/null | wc -l | tr -d ' ')
    ready=$(kubectl get certificate -A --no-headers 2>/dev/null | awk '$3=="True"' | wc -l | tr -d ' ')
    echo "  certificates ready: ${ready}/${total}"
    if [ "${total}" -gt 0 ] && [ "${total}" -eq "${ready}" ]; then
      if [ "${total}" -eq "${prev}" ]; then stable=$((stable + 1)); [ "${stable}" -ge 2 ] && break
      else stable=0; fi
    else stable=0; fi
    prev="${total}"; sleep 15
  done
}

bash "${DIR}/01-deploy.sh"            "${DOMAIN}" "${EMAIL}" "${MASTER_PASSWORD}"
bash "${DIR}/02-networking.sh"        "${DOMAIN}"
wait_for_certs
bash "${DIR}/03-restart-oidc-apps.sh"
bash "${DIR}/04-nextcloud-office.sh"
bash "${DIR}/05-docs.sh"
bash "${DIR}/06-grist.sh"
bash "${DIR}/07-session-lifetimes.sh" "${DOMAIN}"
bash "${DIR}/08-open-suite-portal.sh"
bash "${DIR}/09-portal-header.sh"
bash "${DIR}/10-keycloak-login.sh"

echo ""
echo "############################################################"
echo "# Open Suite deployed: https://bridge.${DOMAIN}"
echo "############################################################"
