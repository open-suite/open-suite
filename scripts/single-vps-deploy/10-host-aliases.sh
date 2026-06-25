#!/usr/bin/env bash
# Usage: ./10-host-aliases.sh
#
# Adds Open Suite convenience hostnames that are not part of the upstream
# MijnBureau chart:
#   - https://DOMAIN redirects to the canonical portal at https://bridge.DOMAIN.
#   - https://admin.DOMAIN redirects to https://id.DOMAIN/admin/.
set -euo pipefail

DOMAIN="${1:-$(cat /etc/mijnbureau/domain 2>/dev/null || true)}"
if [ -z "${DOMAIN}" ]; then
  echo "No domain found. Pass it as an argument, or run 01-deploy.sh first." >&2
  exit 1
fi

export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

echo "==> Adding root portal redirect https://${DOMAIN} -> https://bridge.${DOMAIN}"
kubectl apply -f - <<YAML
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: opensuite-root-to-bridge
  namespace: mb-bureaublad
spec:
  redirectRegex:
    regex: ^https://${DOMAIN//./\\.}/?(.*)
    replacement: https://bridge.${DOMAIN}/\${1}
    permanent: false
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: opensuite-root-portal
  namespace: mb-bureaublad
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    traefik.ingress.kubernetes.io/router.middlewares: mb-bureaublad-opensuite-root-to-bridge@kubernetescrd,mb-bureaublad-hsts-header@kubernetescrd
spec:
  ingressClassName: traefik
  rules:
    - host: ${DOMAIN}
      http:
        paths:
          - path: /
            pathType: ImplementationSpecific
            backend:
              service:
                name: bureaublad-frontend
                port:
                  name: http
  tls:
    - hosts:
        - ${DOMAIN}
      secretName: ${DOMAIN}-tls
YAML

echo "==> Adding temporary admin redirect https://admin.${DOMAIN} -> https://id.${DOMAIN}/admin/"
kubectl apply -f - <<YAML
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: opensuite-admin-to-id
  namespace: mb-keycloak
spec:
  redirectRegex:
    regex: ^https://admin\\.${DOMAIN//./\\.}/?(.*)
    replacement: https://id.${DOMAIN}/admin/\${1}
    permanent: false
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: opensuite-admin-redirect
  namespace: mb-keycloak
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    traefik.ingress.kubernetes.io/router.middlewares: mb-keycloak-opensuite-admin-to-id@kubernetescrd,mb-keycloak-hsts-header@kubernetescrd
spec:
  ingressClassName: traefik
  rules:
    - host: admin.${DOMAIN}
      http:
        paths:
          - path: /
            pathType: ImplementationSpecific
            backend:
              service:
                name: keycloak-keycloak
                port:
                  name: http
  tls:
    - hosts:
        - admin.${DOMAIN}
      secretName: admin.${DOMAIN}-tls
YAML

echo "==> Host aliases installed"
