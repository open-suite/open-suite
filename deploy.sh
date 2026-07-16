#!/usr/bin/env bash
# Usage: sudo ./deploy.sh <domain> <email>
#
# Single happy-path deploy for open-suite on a fresh Ubuntu 24.04 VPS (k3s).
# Runs the MinBZK base (01-04: helmfile + patches, networking, cert wait,
# restarts, office cache) then the Open Suite layer (08-12: portal, header,
# login theme, auth gate). Gaps in the numbering are steps made declarative and
# deleted (tickets 3.4, 2.1, 2.2). Element and Meet ship as CI-built images
# pinned in the demo values. Final URL: https://bridge.DOMAIN
#
# Run this from a checkout of the open-suite repo on the target VPS, as root.
# Every step is idempotent, so re-running is safe.
set -euo pipefail

DOMAIN="${1:?Usage: $0 <domain> <email>}"
EMAIL="${2:?Usage: $0 <domain> <email>}"
if [ "$#" -gt 2 ]; then
  echo "ERROR: do not pass the master password on the command line." >&2
  echo "Use OPEN_SUITE_MASTER_PASSWORD_FILE, MIJNBUREAU_MASTER_PASSWORD, or the interactive prompt." >&2
  exit 2
fi
OPEN_SUITE_DEMO_MODE="${OPEN_SUITE_DEMO_MODE:-false}"
OPEN_SUITE_DEMO_USERNAME="${OPEN_SUITE_DEMO_USERNAME:-johndoe}"
OPEN_SUITE_DEMO_PASSWORD="${OPEN_SUITE_DEMO_PASSWORD:-myStrongPassword123}"
# No fallback to MASTER_PASSWORD: when the admin password is unset, 01-deploy.sh
# generates one and the login page never shows admin credentials.
OPEN_SUITE_DEMO_ADMIN_USERNAME="${OPEN_SUITE_DEMO_ADMIN_USERNAME:-demoadmin}"
OPEN_SUITE_DEMO_ADMIN_PASSWORD="${OPEN_SUITE_DEMO_ADMIN_PASSWORD:-}"
export OPEN_SUITE_DEMO_MODE OPEN_SUITE_DEMO_USERNAME OPEN_SUITE_DEMO_PASSWORD
export OPEN_SUITE_DEMO_ADMIN_USERNAME OPEN_SUITE_DEMO_ADMIN_PASSWORD
export OPEN_SUITE_TLS_MODE="${OPEN_SUITE_TLS_MODE:-letsencrypt}"

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
DIR="${REPO_ROOT}/scripts/single-vps-deploy"
source "${REPO_ROOT}/scripts/lib/state.sh"
MASTER_PASSWORD="$(opensuite_read_master_password)"
[ -n "${MASTER_PASSWORD}" ] || { echo "ERROR: master password must not be empty." >&2; exit 2; }
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

wait_for_certs() {
  echo "==> Waiting for TLS certificates"
  sleep 30
  # Bounded: 80 iterations x 15s = 20 minutes, far beyond a healthy Let's
  # Encrypt issuance. Timing out means DNS/ingress/issuer is broken — fail
  # loudly instead of polling forever.
  local prev=-1 stable=0 total ready attempt
  for ((attempt = 1; attempt <= 80; attempt++)); do
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

MIJNBUREAU_MASTER_PASSWORD="${MASTER_PASSWORD}" bash "${DIR}/01-deploy.sh" "${DOMAIN}" "${EMAIL}"
bash "${DIR}/02-networking.sh"        "${DOMAIN}"
# selfsigned mode has no cert-manager Certificates to wait for — every chart
# generates its own cert secret at render time.
[ "${OPEN_SUITE_TLS_MODE:-letsencrypt}" = "selfsigned" ] || wait_for_certs
bash "${DIR}/03-restart-oidc-apps.sh"
bash "${DIR}/04-nextcloud-office.sh"
bash "${DIR}/08-open-suite-portal.sh"
bash "${DIR}/09-portal-header.sh"
bash "${DIR}/10-keycloak-login.sh"
# 11 (Element bundle patch) is gone: the verification-reminder fix is now baked
# into the ghcr.io/open-suite/element-web image (images/element/), pinned in the
# demo values, so a bare helmfile apply keeps it. See Phase 2.2.
bash "${DIR}/12-auth-gate.sh"
if [ "${OPEN_SUITE_DEMO_MODE}" = "true" ]; then
  bash "${REPO_ROOT}/scripts/demo/install-cron.sh"
fi

echo ""
echo "############################################################"
echo "# Open Suite deployed: https://bridge.${DOMAIN}"
echo "############################################################"
