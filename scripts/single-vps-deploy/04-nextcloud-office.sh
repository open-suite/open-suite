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

# The chart's fresh-install hook treats app installation failures as warnings,
# so the app source can exist while richdocuments remains disabled. Office
# configuration below requires its command namespace: reconcile that state
# strictly here and fail deployment if the app cannot be enabled.
echo "==> Ensuring the Nextcloud Office app is enabled"
kubectl exec -n mb-nextcloud deploy/nextcloud -c nextcloud -- php occ app:enable richdocuments

# The chart's post-install configuration can run before the app is enabled on a
# fresh install, leaving both Collabora URLs empty. Reconcile them after strict
# enablement so activate-config has a discovery endpoint to fetch.
DOMAIN="$(cat /etc/mijnbureau/domain)"
echo "==> Configuring the Nextcloud Office endpoint"
for key in wopi_url public_wopi_url; do
  kubectl exec -n mb-nextcloud deploy/nextcloud -c nextcloud -- \
    php occ config:app:set richdocuments "${key}" --value "https://collabora.${DOMAIN}"
done

# Self-signed deploys: Nextcloud's outbound HTTP client (richdocuments WOPI
# discovery, user_oidc, meetcal) verifies TLS against Nextcloud's own cert
# store. Import the local certs so every occ/app fetch below verifies.
if [ "${OPEN_SUITE_TLS_MODE:-letsencrypt}" = "selfsigned" ]; then
  # Import the chart-generated CAs directly. Reading certificates through
  # Traefik races its dynamic ingress configuration on a fresh deployment and
  # can return no certificate even after the Traefik Deployment is Ready.
  echo "==> Importing self-signed CAs into Nextcloud's certificate store"
  cert_file="$(mktemp)"
  trap 'rm -f "${cert_file}"' EXIT
  for source in mb-keycloak:id mb-collabora:collabora mb-meet:meet mb-nextcloud:nextcloud; do
    namespace="${source%%:*}"
    h="${source#*:}"
    secret="${h}.${DOMAIN}-tls"
    imported=false
    for _ in $(seq 1 30); do
      : > "${cert_file}"
      if kubectl get secret -n "${namespace}" "${secret}" -o jsonpath='{.data.ca\.crt}' \
          | base64 -d > "${cert_file}" \
          && [ -s "${cert_file}" ] \
          && openssl x509 -in "${cert_file}" -noout -checkend 0 >/dev/null 2>&1 \
          && kubectl exec -i -n mb-nextcloud deploy/nextcloud -c nextcloud -- sh -c \
              "cat > /tmp/${h}-ca.crt && php occ security:certificates:import /tmp/${h}-ca.crt" \
              < "${cert_file}"; then
        imported=true
        break
      fi
      sleep 5
    done
    if [ "${imported}" != true ]; then
      echo "ERROR: ${namespace}/${secret} key ca.crt was not a current parseable certificate or could not be imported after 150 seconds" >&2
      kubectl get ingress -n "${namespace}" -o wide >&2 || true
      kubectl get secret -n "${namespace}" "${secret}" >&2 || true
      exit 1
    fi
  done
  rm -f "${cert_file}"
  trap - EXIT
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
