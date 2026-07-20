#!/usr/bin/env bash
# Usage: MIJNBUREAU_MASTER_PASSWORD=... ./01-deploy.sh <domain> <email>
# Runs steps 1-4 of the MijnBureau Hetzner quickstart.
# Must be run as root on a fresh Ubuntu 24.04 server.
#
# The domain is persisted to /etc/mijnbureau/domain so the later scripts in
# this folder pick it up automatically — you only pass it here.
set -euo pipefail

DOMAIN="${1:?Usage: $0 <domain> <email>}"
EMAIL="${2:?Usage: $0 <domain> <email>}"
MASTER_PASSWORD="${MIJNBUREAU_MASTER_PASSWORD:?Set MIJNBUREAU_MASTER_PASSWORD or run deploy.sh}"
OPEN_SUITE_DEMO_MODE="${OPEN_SUITE_DEMO_MODE:-false}"
OPEN_SUITE_DEMO_USERNAME="${OPEN_SUITE_DEMO_USERNAME:-johndoe}"
OPEN_SUITE_DEMO_PASSWORD="${OPEN_SUITE_DEMO_PASSWORD:-myStrongPassword123}"
OPEN_SUITE_DEMO_ADMIN_USERNAME="${OPEN_SUITE_DEMO_ADMIN_USERNAME:-demoadmin}"
# Pinned open-suite-portal commit: selects the CI-built portal images
# (ghcr.io/open-suite/portal-{api,frontend}:sha-<short>). Bump deliberately.
PORTAL_REF="${PORTAL_REF:-ab3ccaffe4d026a079cc0de8119eca49904c4f61}"
# Pinned Open Suite build of the v1.20.0-based Meet frontend.
MEET_TAG="${MEET_TAG:-sha-d1cd4d2}"
# Pinned Open Suite Nextcloud build (upstream base + meetcal + patched user_oidc).
NEXTCLOUD_TAG="${NEXTCLOUD_TAG:-sha-03c989f}"
# Open Suite Element Web image tag: pinned immutable build with verification
# reminders removed and textual assets compressed.
ELEMENT_TAG="${ELEMENT_TAG:-sha-985f709}"
# TLS mode: letsencrypt (default; needs public DNS + ports) or selfsigned
# (local VMs: every chart generates its own cert, no cert-manager, no ACME).
OPEN_SUITE_TLS_MODE="${OPEN_SUITE_TLS_MODE:-letsencrypt}"
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

# Persist state for later steps. Guard the install identity before installing or
# rendering anything: a wrong master password would otherwise rotate every
# derived database/application credential on a rerun.
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "${REPO_ROOT}/scripts/lib/state.sh"
opensuite_prepare_state_dir
opensuite_guard_install_identity "${DOMAIN}" "${MASTER_PASSWORD}"
opensuite_write_state 0644 /etc/mijnbureau/domain "${DOMAIN}"
opensuite_write_state 0600 /etc/mijnbureau/demo-mode "${OPEN_SUITE_DEMO_MODE}"
opensuite_write_state 0600 /etc/mijnbureau/demo-username "${OPEN_SUITE_DEMO_USERNAME}"
opensuite_write_state 0600 /etc/mijnbureau/demo-password "${OPEN_SUITE_DEMO_PASSWORD}"
opensuite_write_state 0600 /etc/mijnbureau/demo-admin-username "${OPEN_SUITE_DEMO_ADMIN_USERNAME}"
opensuite_write_state 0600 /etc/mijnbureau/demo-admin-password "${OPEN_SUITE_DEMO_ADMIN_PASSWORD}"
opensuite_write_state 0600 /etc/mijnbureau/demo-admin-show "${OPEN_SUITE_DEMO_ADMIN_SHOW}"

HELMFILE_V=1.1.7

echo "==> [1/4] Installing k3s, Helm, Helmfile"
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--write-kubeconfig-mode 644" sh -
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
ARCH="$(dpkg --print-architecture 2>/dev/null || uname -m | sed -e s/x86_64/amd64/ -e s/aarch64/arm64/)"
curl -fsSL "https://github.com/helmfile/helmfile/releases/download/v${HELMFILE_V}/helmfile_${HELMFILE_V}_linux_${ARCH}.tar.gz" \
  | tar -xz -C /usr/local/bin helmfile
# Idempotent: the plugin persists across a k3s wipe, so skip if already present.
helm plugin list 2>/dev/null | grep -q '^diff' || helm plugin install https://github.com/databus23/helm-diff

if [ "${OPEN_SUITE_TLS_MODE}" = "selfsigned" ]; then
  echo "==> [2/4] TLS mode selfsigned — skipping cert-manager/ACME"
  TLS_SELF_SIGNED=true
  INGRESS_ANNOTATIONS=""
else
  echo "==> [2/4] Installing cert-manager and ClusterIssuer"
  TLS_SELF_SIGNED=false
  # shellcheck disable=SC2089 # literal YAML rendered by scoped envsubst below
  INGRESS_ANNOTATIONS='"cert-manager.io/cluster-issuer": "letsencrypt-prod"'
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
fi

echo "==> [3/4] Cloning repo and writing config"
# Single-source pin for MinBZK/mijn-bureau-infra: the one commit the local
# patches are known to apply to. Bump UPSTREAM_REF deliberately, re-verifying
# the patch series, never implicitly.
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

if [ "${OPEN_SUITE_TLS_MODE}" = "selfsigned" ]; then
  KC_BACKCHANNEL="http://keycloak-keycloak.mb-keycloak"
else
  KC_BACKCHANNEL="https://id.${DOMAIN}"
fi

# Render the demo environment values from the checked-in template. Only these
# variables are substituted (scoped envsubst) — anything else is left verbatim.
# PORTAL_SHA is the 7-char image tag the portal publish-images workflow uses.
PORTAL_SHA="${PORTAL_REF:0:7}"
# shellcheck disable=SC2090 # INGRESS_ANNOTATIONS intentionally contains YAML quotes
export DOMAIN TLS_SELF_SIGNED INGRESS_ANNOTATIONS NEXTCLOUD_TAG PORTAL_SHA MEET_TAG ELEMENT_TAG KC_BACKCHANNEL
envsubst '${DOMAIN} ${TLS_SELF_SIGNED} ${INGRESS_ANNOTATIONS} ${NEXTCLOUD_TAG} ${PORTAL_SHA} ${MEET_TAG} ${ELEMENT_TAG} ${KC_BACKCHANNEL}' \
  < "${REPO_ROOT}/helmfile/demo-values.yaml.tmpl" \
  > helmfile/environments/demo/mijnbureau.yaml.gotmpl

echo "==> [4/4] Deploying (this takes 10-20 minutes)"
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
export MIJNBUREAU_MASTER_PASSWORD="${MASTER_PASSWORD}"
export MIJNBUREAU_CREATE_NAMESPACES=true

yes | helmfile init || true
helmfile -e demo apply --skip-diff-on-install

echo ""
echo "Deploy complete. Continue with steps 5-6 of the guide (networking workarounds + post-deploy fixes)."
echo "Domain: ${DOMAIN}"
