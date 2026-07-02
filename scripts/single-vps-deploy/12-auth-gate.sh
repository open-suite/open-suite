#!/usr/bin/env bash
# Usage: ./12-auth-gate.sh
#
# Deploy the Open Suite edge auth gate and attach it to protected app ingresses.
set -euo pipefail

export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOMAIN="$(cat /etc/mijnbureau/domain)"
AUTH_HOST="auth.${DOMAIN}"
CLIENT_ID="opensuite-auth-gate"
NAMESPACE="mb-bureaublad"
IMAGE="open-suite/auth-gate:local"

echo "==> [1/6] Ensuring auth-gate secrets"
mkdir -p /etc/mijnbureau
if [ ! -f /etc/mijnbureau/auth-gate-client-secret ]; then
  openssl rand -base64 36 | tr -d '\n' > /etc/mijnbureau/auth-gate-client-secret
fi
if [ ! -f /etc/mijnbureau/auth-gate-cookie-secret ]; then
  openssl rand -base64 48 | tr -d '\n' > /etc/mijnbureau/auth-gate-cookie-secret
fi
CLIENT_SECRET="$(cat /etc/mijnbureau/auth-gate-client-secret)"
COOKIE_SECRET="$(cat /etc/mijnbureau/auth-gate-cookie-secret)"

echo "==> [2/6] Creating/updating Keycloak client ${CLIENT_ID}"
KC_PASS="$(kubectl -n mb-keycloak get secret keycloak-keycloak -o jsonpath='{.data.admin-password}' | base64 -d)"
kubectl -n mb-keycloak exec -i keycloak-keycloak-0 -c keycloak -- sh -s -- \
  "$KC_PASS" "$CLIENT_ID" "$CLIENT_SECRET" "$AUTH_HOST" <<'SH'
set -e
KC=/opt/bitnami/keycloak/bin/kcadm.sh
CFG=/tmp/opensuite-auth-gate-kcadm.config
ADMIN_PASS="$1"
CLIENT_ID="$2"
CLIENT_SECRET="$3"
AUTH_HOST="$4"
"$KC" config credentials --config "$CFG" --server http://localhost:8080/ --realm master --user admin --password "$ADMIN_PASS" >/dev/null
CLIENT_UUID="$("$KC" get clients -r mijnbureau --config "$CFG" -q clientId="$CLIENT_ID" --fields id 2>/dev/null | grep -oE '[0-9a-f-]{36}' | head -1 || true)"
cat >/tmp/opensuite-auth-gate-client.json <<EOF
{
  "clientId": "$CLIENT_ID",
  "name": "Open Suite Auth Gate",
  "enabled": true,
  "publicClient": false,
  "standardFlowEnabled": true,
  "directAccessGrantsEnabled": false,
  "serviceAccountsEnabled": false,
  "secret": "$CLIENT_SECRET",
  "redirectUris": ["https://$AUTH_HOST/callback"],
  "webOrigins": ["https://$AUTH_HOST"],
  "attributes": {
    "pkce.code.challenge.method": "S256",
    "post.logout.redirect.uris": "+"
  }
}
EOF
if [ -z "$CLIENT_UUID" ]; then
  "$KC" create clients -r mijnbureau --config "$CFG" -f /tmp/opensuite-auth-gate-client.json >/dev/null
else
  "$KC" update "clients/$CLIENT_UUID" -r mijnbureau --config "$CFG" -f /tmp/opensuite-auth-gate-client.json >/dev/null
fi
CLIENT_UUID="$("$KC" get clients -r mijnbureau --config "$CFG" -q clientId="$CLIENT_ID" --fields id 2>/dev/null | grep -oE '[0-9a-f-]{36}' | head -1 || true)"
test -n "$CLIENT_UUID"
SH

echo "==> [3/6] Building auth-gate image"
docker buildx build --load -t "${IMAGE}" "${REPO_ROOT}/overlays/auth-gate"
docker save "${IMAGE}" | k3s ctr -n k8s.io images import -

echo "==> [4/6] Applying auth-gate Kubernetes resources"
kubectl -n "${NAMESPACE}" create secret generic opensuite-auth-gate \
  --from-literal=OIDC_CLIENT_SECRET="${CLIENT_SECRET}" \
  --from-literal=COOKIE_SECRET="${COOKIE_SECRET}" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl apply -f - <<YAML
apiVersion: apps/v1
kind: Deployment
metadata:
  name: opensuite-auth-gate
  namespace: ${NAMESPACE}
  labels:
    app.kubernetes.io/name: opensuite-auth-gate
    app.kubernetes.io/part-of: open-suite
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: opensuite-auth-gate
  template:
    metadata:
      labels:
        app.kubernetes.io/name: opensuite-auth-gate
        app.kubernetes.io/part-of: open-suite
    spec:
      containers:
        - name: auth-gate
          image: ${IMAGE}
          imagePullPolicy: Never
          ports:
            - name: http
              containerPort: 8080
          env:
            - name: OPEN_SUITE_DOMAIN
              value: "${DOMAIN}"
            - name: OPEN_SUITE_AUTH_HOST
              value: "${AUTH_HOST}"
            - name: OIDC_ISSUER
              value: "https://id.${DOMAIN}/realms/mijnbureau"
            - name: OIDC_CLIENT_ID
              value: "${CLIENT_ID}"
            - name: OIDC_CLIENT_SECRET
              valueFrom:
                secretKeyRef:
                  name: opensuite-auth-gate
                  key: OIDC_CLIENT_SECRET
            - name: COOKIE_SECRET
              valueFrom:
                secretKeyRef:
                  name: opensuite-auth-gate
                  key: COOKIE_SECRET
          readinessProbe:
            httpGet:
              path: /healthz
              port: http
            initialDelaySeconds: 2
            periodSeconds: 5
          livenessProbe:
            httpGet:
              path: /healthz
              port: http
            initialDelaySeconds: 10
            periodSeconds: 10
---
apiVersion: v1
kind: Service
metadata:
  name: opensuite-auth-gate
  namespace: ${NAMESPACE}
spec:
  selector:
    app.kubernetes.io/name: opensuite-auth-gate
  ports:
    - name: http
      port: 80
      targetPort: http
---
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: opensuite-auth-gate
  namespace: ${NAMESPACE}
spec:
  forwardAuth:
    address: http://opensuite-auth-gate.${NAMESPACE}.svc.cluster.local/auth
    trustForwardHeader: true
    authResponseHeaders:
      - X-Open-Suite-User
      - X-Open-Suite-Email
      - X-Open-Suite-Name
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: opensuite-auth-gate
  namespace: ${NAMESPACE}
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: opensuite-auth-gate
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - ports:
        - port: 8080
          protocol: TCP
  egress:
    - ports:
        - port: 53
          protocol: UDP
        - port: 53
          protocol: TCP
    - ports:
        - port: 443
          protocol: TCP
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: opensuite-auth-gate
  namespace: ${NAMESPACE}
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    traefik.ingress.kubernetes.io/router.middlewares: ${NAMESPACE}-hsts-header@kubernetescrd
spec:
  ingressClassName: traefik
  tls:
    - hosts:
        - ${AUTH_HOST}
      secretName: ${AUTH_HOST}-tls
  rules:
    - host: ${AUTH_HOST}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: opensuite-auth-gate
                port:
                  name: http
YAML

kubectl -n "${NAMESPACE}" rollout restart deploy/opensuite-auth-gate
kubectl -n "${NAMESPACE}" rollout status deploy/opensuite-auth-gate --timeout=120s
kubectl -n "${NAMESPACE}" wait --for=condition=Ready "certificate/${AUTH_HOST}-tls" --timeout=180s

echo "==> [5/6] Attaching auth middleware to protected ingresses"
append_middleware() {
  local ns="$1" ingress="$2" auth_ref="${NAMESPACE}-opensuite-auth-gate@kubernetescrd"
  local current next
  current="$(kubectl -n "$ns" get ingress "$ingress" -o jsonpath='{.metadata.annotations.traefik\.ingress\.kubernetes\.io/router\.middlewares}' 2>/dev/null || true)"
  next="$(python3 -c '
import sys
current, auth_ref = sys.argv[1], sys.argv[2]
items = [x.strip() for x in current.split(",") if x.strip()]
if auth_ref not in items:
    items.append(auth_ref)
print(",".join(items))
' "$current" "$auth_ref")"
  kubectl -n "$ns" annotate ingress "$ingress" "traefik.ingress.kubernetes.io/router.middlewares=${next}" --overwrite
  kubectl -n "$ns" annotate ingress "$ingress" kubectl.kubernetes.io/last-applied-configuration- >/dev/null 2>&1 || true
}

append_middleware mb-bureaublad bureaublad
kubectl -n mb-bureaublad get ingress opensuite-root-portal >/dev/null 2>&1 && append_middleware mb-bureaublad opensuite-root-portal
append_middleware mb-meet meet
append_middleware mb-nextcloud nextcloud
for ingress in docs docs-backend-admin docs-media docs-y-provider-api docs-y-provider-ws; do
  kubectl -n mb-docs get ingress "$ingress" >/dev/null 2>&1 && append_middleware mb-docs "$ingress"
done
append_middleware mb-grist grist
append_middleware mb-element element-web
append_middleware mb-element synapse

echo "==> [6/6] Auth gate ready"
echo "Protected workspace traffic now authenticates through https://${AUTH_HOST}"
