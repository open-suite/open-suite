#!/usr/bin/env bash
# Usage: ./04-nextcloud-office.sh
# Warms the Collabora capabilities cache so Office files open in Nextcloud.
# Run after 03 (which restarts Nextcloud and sets the SSRF allowance).
# Safe to run repeatedly — every action is idempotent.
#
# Why: richdocuments caches the capabilities document it fetches from Collabora
# (collabora.DOMAIN/hosting/discovery). On a first deploy that fetch happens
# before step 5's networking exists, so an empty/failed response gets cached.
# Every file-open then calls ->xpath() on that cached `false` and 500s
# (richdocuments/lib/WOPI/Parser.php). Re-running the config fetch, now that the
# network path works, replaces the bad cache with a valid one.
set -euo pipefail

export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

echo "==> Waiting for Nextcloud to be ready"
kubectl rollout status deploy/nextcloud -n mb-nextcloud --timeout=300s
# On a fresh install the pod turns Ready while the entrypoint is still
# populating /var/www/html on the PVC, and an early occ exec dies with
# "versioncheck.php not found". Wait until occ itself answers.
for i in $(seq 1 30); do
  kubectl exec -n mb-nextcloud deploy/nextcloud -c nextcloud -- php occ status >/dev/null 2>&1 && break
  [ "$i" = 30 ] && { echo "ERROR: occ not responding after 5 minutes" >&2; exit 1; }
  sleep 10
done

# A custom app image can carry a newer app version than the database. Until the
# upgrade runs, Nextcloud restricts occ to a small command set, so the
# richdocuments cache warm below fails with "no commands defined". This is a
# no-op when core and all apps are already current.
echo "==> Applying pending Nextcloud/core app database upgrades"
kubectl exec -n mb-nextcloud deploy/nextcloud -c nextcloud -- php occ upgrade

# Self-signed deploys: Nextcloud's outbound HTTP client (richdocuments WOPI
# discovery, user_oidc, meetcal) verifies TLS against Nextcloud's own cert
# store. Import the local certs so every occ/app fetch below verifies.
if [ "${OPEN_SUITE_TLS_MODE:-letsencrypt}" = "selfsigned" ]; then
  DOMAIN="$(cat /etc/mijnbureau/domain)"
  echo "==> Importing self-signed certs into Nextcloud's certificate store"
  for h in id collabora meet nextcloud; do
    kubectl exec -n mb-nextcloud deploy/nextcloud -c nextcloud -- sh -c "
      echo | openssl s_client -connect ${h}.${DOMAIN}:443 -servername ${h}.${DOMAIN} 2>/dev/null \
        | openssl x509 -outform PEM > /tmp/${h}.crt && php occ security:certificates:import /tmp/${h}.crt"
  done
fi

if [ "${OPEN_SUITE_TLS_MODE:-letsencrypt}" = "selfsigned" ]; then
  # The cert-store import above covers app code using IClientService, but
  # richdocuments' discovery fetch still verifies against the system bundle —
  # it ships its own toggle for exactly this.
  kubectl exec -n mb-nextcloud deploy/nextcloud -c nextcloud -- \
    php occ config:app:set richdocuments disable_certificate_verification --value yes
fi

echo "==> Refreshing Collabora capabilities cache"
# activate-config re-fetches /hosting/discovery + /hosting/capabilities and
# rewrites the cache. Idempotent: running it again just re-fetches.
kubectl exec -n mb-nextcloud deploy/nextcloud -c nextcloud -- php occ richdocuments:activate-config

echo ""
echo "Done. Office files (xlsx/docx/etc.) should now open in Nextcloud."
