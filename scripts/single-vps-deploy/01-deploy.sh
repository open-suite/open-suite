#!/usr/bin/env bash
# Usage: ./01-deploy.sh <domain> <email> <master-password>
# Runs steps 1-4 of the MijnBureau Hetzner quickstart.
# Must be run as root on a fresh Ubuntu 24.04 server.
#
# The domain is persisted to /etc/mijnbureau/domain so the later scripts in
# this folder pick it up automatically — you only pass it here.
set -euo pipefail

DOMAIN="${1:?Usage: $0 <domain> <email> <master-password>}"
EMAIL="${2:?Usage: $0 <domain> <email> <master-password>}"
MASTER_PASSWORD="${3:?Usage: $0 <domain> <email> <master-password>}"
OPEN_SUITE_DEMO_MODE="${OPEN_SUITE_DEMO_MODE:-false}"
OPEN_SUITE_DEMO_USERNAME="${OPEN_SUITE_DEMO_USERNAME:-johndoe}"
OPEN_SUITE_DEMO_PASSWORD="${OPEN_SUITE_DEMO_PASSWORD:-myStrongPassword123}"
OPEN_SUITE_DEMO_ADMIN_USERNAME="${OPEN_SUITE_DEMO_ADMIN_USERNAME:-demoadmin}"
# The demo admin password never defaults to the master password. Explicitly set
# → persisted and shown on the login-page credential panel. Unset → generated
# (kept across re-runs) and never shown; read it from
# /etc/mijnbureau/demo-admin-password on the box.
OPEN_SUITE_DEMO_ADMIN_SHOW=false
if [ -n "${OPEN_SUITE_DEMO_ADMIN_PASSWORD:-}" ]; then
  OPEN_SUITE_DEMO_ADMIN_SHOW=true
elif [ -s /etc/mijnbureau/demo-admin-password ] \
  && [ "$(cat /etc/mijnbureau/demo-admin-show 2>/dev/null)" = "false" ]; then
  # Reuse a previously generated password — but never one persisted by an older
  # deploy (no demo-admin-show marker), which may be the master password.
  OPEN_SUITE_DEMO_ADMIN_PASSWORD="$(cat /etc/mijnbureau/demo-admin-password)"
else
  OPEN_SUITE_DEMO_ADMIN_PASSWORD="$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)"
fi

# Persist the domain for the later scripts (02-networking.sh, 03-...).
mkdir -p /etc/mijnbureau
echo "${DOMAIN}" > /etc/mijnbureau/domain
printf '%s' "${OPEN_SUITE_DEMO_MODE}" > /etc/mijnbureau/demo-mode
printf '%s' "${OPEN_SUITE_DEMO_USERNAME}" > /etc/mijnbureau/demo-username
printf '%s' "${OPEN_SUITE_DEMO_PASSWORD}" > /etc/mijnbureau/demo-password
printf '%s' "${OPEN_SUITE_DEMO_ADMIN_USERNAME}" > /etc/mijnbureau/demo-admin-username
(umask 077; printf '%s' "${OPEN_SUITE_DEMO_ADMIN_PASSWORD}" > /etc/mijnbureau/demo-admin-password)
chmod 600 /etc/mijnbureau/demo-admin-password
printf '%s' "${OPEN_SUITE_DEMO_ADMIN_SHOW}" > /etc/mijnbureau/demo-admin-show

HELMFILE_V=1.1.7

echo "==> [1/4] Installing k3s, Helm, Helmfile"
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--write-kubeconfig-mode 644" sh -
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
curl -fsSL "https://github.com/helmfile/helmfile/releases/download/v${HELMFILE_V}/helmfile_${HELMFILE_V}_linux_amd64.tar.gz" \
  | tar -xz -C /usr/local/bin helmfile
# Idempotent: the plugin persists across a k3s wipe, so skip if already present.
helm plugin list 2>/dev/null | grep -q '^diff' || helm plugin install https://github.com/databus23/helm-diff

echo "==> [2/4] Installing cert-manager and ClusterIssuer"
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.16.2/cert-manager.yaml
kubectl -n cert-manager rollout status deploy/cert-manager-webhook --timeout=180s

kubectl apply -f - <<YAML
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata: { name: letsencrypt-prod }
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: ${EMAIL}
    privateKeySecretRef: { name: letsencrypt-prod-account-key }
    solvers: [{ http01: { ingress: { class: traefik } } }]
YAML

echo "==> [3/4] Cloning repo and writing config"
# Single-source pin for MinBZK/mijn-bureau-infra: the one commit the local
# patches are known to apply to. Bump UPSTREAM_REF deliberately, re-verifying
# the patch series, never implicitly.
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
UPSTREAM_REF="$(cat "${REPO_ROOT}/UPSTREAM_REF")"
cd /root
# Clone-or-reset: re-runs must start from a pristine upstream tree at the
# pinned ref, never stack patches on an already-patched checkout.
if [ ! -d mijn-bureau-infra/.git ]; then
  git clone https://github.com/MinBZK/mijn-bureau-infra
fi
git -C mijn-bureau-infra fetch origin
git -C mijn-bureau-infra reset --hard "${UPSTREAM_REF}"
git -C mijn-bureau-infra clean -fd
cd mijn-bureau-infra

# Apply our local patches over the vendored MinBZK infra (Open Suite branding,
# etc.). Check them all against the clean tree first so a drifted upstream
# fails fast with nothing half-applied; --3way turns context drift into a
# visible conflict instead of a refused hunk.
for p in "${REPO_ROOT}"/patches/local/*.patch; do
  [ -e "$p" ] || continue
  if ! git apply --3way --check "$p"; then
    echo "ERROR: patch does not apply to upstream $(git rev-parse --short HEAD): $(basename "$p")" >&2
    exit 1
  fi
done
for p in "${REPO_ROOT}"/patches/local/*.patch; do
  [ -e "$p" ] || continue
  echo "==> Applying local patch: $(basename "$p")"
  git apply --3way "$p"
done

cat > helmfile/environments/demo/mijnbureau.yaml.gotmpl <<YAML
---
global:
  domain: "${DOMAIN}"
  # Open Suite serves the portal at bridge.DOMAIN (upstream default: bureaublad).
  # This one value also drives the portal's Keycloak client redirect URIs and the
  # cross-app "open portal" buttons, so they all move together.
  hostname:
    bureaublad: "bridge"
  resourcesPreset: "none"
  resourcesPresetPerApp:
    collabora: "none"
    elementweb: "none"
    keycloak: "none"
    ollama: "none"
    synapse: "none"
    grist: "none"
    livekit: "none"
    meet: { backend: "none", frontend: "none" }
    nextcloud: "none"
    docs: { backend: "none", frontend: "none", celery: "none", yProvider: "none", docspec: "none" }
    drive: { backend: "none", frontend: "none" }
    conversations: { backend: "none", frontend: "none" }
    bureaublad: { backend: "none", frontend: "none" }
  tls:
    enabled: true
    selfSigned: false

autoscaling:
  horizontal:
    # Grist keeps upload state on the pod and has no session affinity, so a
    # second replica breaks file imports ("Unknown upload"). Disable the HPA;
    # the chart then pins the deployment to replicaCount (1). Same reasoning
    # as upstream's collabora exception.
    grist:
      enabled: false

cluster:
  routingMode: ingress
  ingress:
    type: traefik
    annotations:
      cert-manager.io/cluster-issuer: letsencrypt-prod
  networking:
    podSubnet:
      - "10.42.0.0/16"
    serviceSubnet:
      - "10.43.0.0/16"

application:
  ollama:
    enabled: false
  # Antivirus and project-management are disabled for this install. To re-enable:
  # set enabled: true and give each a namespace. OpenProject additionally needs
  # the security.openproject and tls.openproject blocks (see the guide).
  clamav:
    enabled: false
  openproject:
    enabled: false
  keycloak:    { namespace: mb-keycloak }
  grist:       { namespace: mb-grist }
  element:     { namespace: mb-element }
  collabora:   { namespace: mb-collabora }
  nextcloud:   { namespace: mb-nextcloud }
  livekit:     { namespace: mb-livekit }
  meet:        { namespace: mb-meet }
  docs:        { namespace: mb-docs }
  bureaublad:  { namespace: mb-bureaublad }

authentication:
  oidc:
    issuer: "https://id.${DOMAIN}/realms/mijnbureau"
    authorization_endpoint: "https://id.${DOMAIN}/realms/mijnbureau/protocol/openid-connect/auth"
    token_endpoint: "https://id.${DOMAIN}/realms/mijnbureau/protocol/openid-connect/token"
    introspection_endpoint: "https://id.${DOMAIN}/realms/mijnbureau/protocol/openid-connect/token/introspect"
    userinfo_endpoint: "https://id.${DOMAIN}/realms/mijnbureau/protocol/openid-connect/userinfo"
    end_session_endpoint: "https://id.${DOMAIN}/realms/mijnbureau/protocol/openid-connect/logout"
    jwks_uri: "https://id.${DOMAIN}/realms/mijnbureau/protocol/openid-connect/certs"

# Open Suite: gate the workspace app ingresses behind the edge auth gate
# (12-auth-gate.sh deploys the gate itself). Consumed by
# patches/local/auth-gate-ingress-middleware.patch, which appends the
# forwardAuth middleware to each patched ingress's middleware chain. Keycloak
# stays ungated — gating the IdP would loop the login. Until 12 creates the
# Middleware object the gated routers fail closed; on a first deploy that
# window is before the stack is usable anyway.
opensuite:
  authGate:
    enabled: true

YAML

echo "==> [4/4] Deploying (this takes 10-20 minutes)"
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
export MIJNBUREAU_MASTER_PASSWORD="${MASTER_PASSWORD}"
export MIJNBUREAU_CREATE_NAMESPACES=true

yes | helmfile init || true
helmfile -e demo apply --skip-diff-on-install

echo ""
echo "Deploy complete. Continue with steps 5-6 of the guide (networking workarounds + post-deploy fixes)."
echo "Domain: ${DOMAIN}"
