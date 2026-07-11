#!/usr/bin/env bash
# Usage: ./12-auth-gate.sh
#
# Deploy the Open Suite edge auth gate. Attaching it to the protected app
# ingresses is declarative: patches/local/auth-gate-ingress-middleware.patch
# appends the forwardAuth middleware to each gated ingress's annotation when
# the demo values set opensuite.authGate.enabled (01-deploy.sh does).
set -euo pipefail
umask 077

export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

DOMAIN="$(cat /etc/mijnbureau/domain)"
AUTH_HOST="auth.${DOMAIN}"
CLIENT_ID="opensuite-auth-gate"
NAMESPACE="mb-bureaublad"
# Prebuilt in CI and pulled from GHCR (ticket 3.1). Pinned to a specific build
# (not floating :main) so a redeploy is reproducible; bump this when the gate
# changes. sha-309302a = the #114 build with the richdocuments/settings WOPI
# pass-through. Override AUTH_GATE_IMAGE to test another tag.
IMAGE="${AUTH_GATE_IMAGE:-ghcr.io/open-suite/auth-gate:sha-309302a}"
OPEN_SUITE_TLS_MODE="${OPEN_SUITE_TLS_MODE:-letsencrypt}"

echo "==> [1/5] Ensuring auth-gate secrets"
install -d -m 0700 /etc/mijnbureau
if [ ! -f /etc/mijnbureau/auth-gate-client-secret ]; then
  openssl rand -base64 36 | tr -d '\n' > /etc/mijnbureau/auth-gate-client-secret
fi
if [ ! -f /etc/mijnbureau/auth-gate-cookie-secret ]; then
  openssl rand -base64 48 | tr -d '\n' > /etc/mijnbureau/auth-gate-cookie-secret
fi
chmod 0600 /etc/mijnbureau/auth-gate-client-secret /etc/mijnbureau/auth-gate-cookie-secret
CLIENT_SECRET="$(cat /etc/mijnbureau/auth-gate-client-secret)"
COOKIE_SECRET="$(cat /etc/mijnbureau/auth-gate-cookie-secret)"

echo "==> [2/5] Creating/updating Keycloak client ${CLIENT_ID}"
# The pod's bootstrap admin password is authoritative (10 refuses a demo
# admin named `admin`, so nothing ever rotates the master account). Passed
# over stdin so it never appears in argv on the host.
KC_ADMIN_PASS="$(kubectl -n mb-keycloak exec keycloak-keycloak-0 -c keycloak -- \
  sh -c 'cat "$KC_BOOTSTRAP_ADMIN_PASSWORD_FILE"')"
printf '%s' "${KC_ADMIN_PASS}" | \
kubectl -n mb-keycloak exec -i keycloak-keycloak-0 -c keycloak -- sh -c '
set -e
KC=/opt/bitnami/keycloak/bin/kcadm.sh
CFG=/tmp/opensuite-auth-gate-kcadm.config
CLIENT_ID="$1"
CLIENT_SECRET="$2"
AUTH_HOST="$3"
ADMIN_PASS="$(cat)"
"$KC" config credentials --config "$CFG" --server http://localhost:8080/ --realm master --user admin --password "$ADMIN_PASS" >/dev/null
CLIENT_UUID="$("$KC" get clients -r mijnbureau --config "$CFG" -q clientId="$CLIENT_ID" --fields id 2>/dev/null | grep -oE "[0-9a-f-]{36}" | head -1 || true)"
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
  "frontchannelLogout": true,
  "attributes": {
    "pkce.code.challenge.method": "S256",
    "post.logout.redirect.uris": "+",
    "frontchannel.logout.url": "https://$AUTH_HOST/frontchannel-logout",
    "frontchannel.logout.session.required": "true"
  }
}
EOF
if [ -z "$CLIENT_UUID" ]; then
  "$KC" create clients -r mijnbureau --config "$CFG" -f /tmp/opensuite-auth-gate-client.json >/dev/null
else
  "$KC" update "clients/$CLIENT_UUID" -r mijnbureau --config "$CFG" -f /tmp/opensuite-auth-gate-client.json >/dev/null
fi
CLIENT_UUID="$("$KC" get clients -r mijnbureau --config "$CFG" -q clientId="$CLIENT_ID" --fields id 2>/dev/null | grep -oE "[0-9a-f-]{36}" | head -1 || true)"
test -n "$CLIENT_UUID"
' sh "$CLIENT_ID" "$CLIENT_SECRET" "$AUTH_HOST"

echo "==> [3/5] Using prebuilt auth-gate image ${IMAGE}"

echo "==> [4/5] Applying auth-gate Kubernetes resources"
if [ "${OPEN_SUITE_TLS_MODE}" = "selfsigned" ]; then
  CERT_ANNOTATION="opensuite.online/tls: selfsigned"
  GATE_TLS_INSECURE="1"
  # No cert-manager in selfsigned mode: mint the gate's cert ourselves,
  # matching what the charts do for the app hosts.
  if ! kubectl -n "${NAMESPACE}" get secret "${AUTH_HOST}-tls" >/dev/null 2>&1; then
    TMPCRT="$(mktemp -d)"
    openssl req -x509 -newkey rsa:2048 -keyout "${TMPCRT}/tls.key" -out "${TMPCRT}/tls.crt" \
      -days 365 -nodes -subj "/CN=${AUTH_HOST}" -addext "subjectAltName=DNS:${AUTH_HOST}" >/dev/null 2>&1
    kubectl -n "${NAMESPACE}" create secret tls "${AUTH_HOST}-tls" \
      --cert="${TMPCRT}/tls.crt" --key="${TMPCRT}/tls.key"
    rm -rf "${TMPCRT}"
  fi
else
  CERT_ANNOTATION="cert-manager.io/cluster-issuer: letsencrypt-prod"
  GATE_TLS_INSECURE="0"
fi
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
          imagePullPolicy: Always
          resources:
            requests:
              cpu: 25m
              memory: 32Mi
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
            - name: OIDC_TLS_INSECURE
              value: "${GATE_TLS_INSECURE}"
            - name: SESSION_TTL_SECONDS
              value: "604800"
            - name: OIDC_VALIDATION_INTERVAL_SECONDS
              value: "15"
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
    # k3s Traefik listens on 8443, not 443 — this is the path to id.${DOMAIN}
    # (token, userinfo, JWKS), same as 02-networking.sh grants the app
    # namespaces. Without it the gate only works via the namespace-wide
    # allow-egress-traefik policy.
    - ports:
        - port: 8443
          protocol: TCP
      to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: opensuite-auth-gate
  namespace: ${NAMESPACE}
  annotations:
    ${CERT_ANNOTATION}
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
if [ "${OPEN_SUITE_TLS_MODE}" != "selfsigned" ]; then
  kubectl -n "${NAMESPACE}" wait --for=condition=Ready "certificate/${AUTH_HOST}-tls" --timeout=180s
fi

echo "==> [5/5] Auth gate ready"
echo "Protected workspace traffic now authenticates through https://${AUTH_HOST}"
