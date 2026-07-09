#!/usr/bin/env bash
# Usage: ./08-open-suite-portal.sh
# Open Suite portal layer on top of the MinBZK base (scripts 01-04):
# installs the Nextcloud apps (calendar, deck, contacts).
#
# Everything else that used to live here is declarative now:
#   - portal images: container.bureaublad.* in the demo values (01-deploy.sh),
#     pinned to PORTAL_REF, so helmfile owns them and a re-apply cannot revert
#     the portal to upstream images
#   - calendar/tasks env wiring: patches/local/bureaublad-calendar-env.patch
#
# Idempotent and safe to re-run.
set -euo pipefail

export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

echo "==> Installing the Nextcloud apps (calendar, deck, contacts)"
# deck backs the "Projects" claim on the landing page; contacts backs the
# people/invite flows. install fails if already installed, then enable is
# the no-op-safe fallback.
for app in calendar deck contacts; do
  kubectl -n mb-nextcloud exec deploy/nextcloud -c nextcloud -- \
    sh -c "cd /var/www/html && (php occ app:install $app || php occ app:enable $app)"
done

# meetcal ships in the image (synced onto custom_apps by an entrypoint hook)
# and the chart's post-install occ enable races that sync on a FRESH install —
# the files don't exist yet, the enable no-ops, and the app sits disabled.
# Enable it here too, late and reliably; enabling an enabled app is a no-op.
kubectl -n mb-nextcloud exec deploy/nextcloud -c nextcloud -- \
  sh -c "cd /var/www/html && php occ app:enable meetcal"

# The portal is served at bridge.<domain>; the bare apex <domain> has no app
# and no cert of its own, so a visitor typing it hit Traefik's default
# self-signed cert (ERR_CERT_AUTHORITY_INVALID). Give the apex its own LE cert
# and 301-redirect it to the portal. Idempotent (kubectl apply).
DOMAIN="$(cat /etc/mijnbureau/domain 2>/dev/null || true)"
if [ -n "${DOMAIN}" ]; then
  echo "==> Apex ${DOMAIN} -> https://bridge.${DOMAIN} redirect (+ LE cert)"
  kubectl apply -f - <<YAML
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: apex-redirect
  namespace: mb-bureaublad
spec:
  redirectRegex:
    regex: "^https?://${DOMAIN//./\\.}/(.*)"
    replacement: "https://bridge.${DOMAIN}/\${1}"
    permanent: true
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: apex-redirect
  namespace: mb-bureaublad
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    traefik.ingress.kubernetes.io/router.middlewares: mb-bureaublad-apex-redirect@kubernetescrd
spec:
  ingressClassName: traefik
  rules:
    - host: ${DOMAIN}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: bureaublad-frontend
                port:
                  number: 80
  tls:
    - hosts: ["${DOMAIN}"]
      secretName: ${DOMAIN}-tls
YAML
fi

echo "Done. Portal images and calendar wiring are owned by helmfile (01)."
