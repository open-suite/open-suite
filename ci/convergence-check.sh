#!/usr/bin/env bash
# Verify that a rendered Helmfile apply plus the procedural deployment steps
# converges to all required Open Suite behavior. This is destructive to the
# live demo while it runs: Helmfile may roll workloads, and the heal phase
# reapplies and verifies all remaining procedural state.
#
# Usage:
#   OPEN_SUITE_MASTER_PASSWORD_FILE=/root/master-password ci/convergence-check.sh
#   MIJNBUREAU_MASTER_PASSWORD=... ci/convergence-check.sh
set -uo pipefail

export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
INFRA="${INFRA_DIR:-/root/mijn-bureau-infra}"
DIR="${REPO}/scripts/single-vps-deploy"
EXPECTED_AUTH_GATE_IMAGE="${AUTH_GATE_IMAGE:-ghcr.io/open-suite/auth-gate:sha-8a7faae}"
EXPECTED_PORTAL_REF="${PORTAL_REF:-1870c55ca0fbf2f5aa2bf50ad4c9c67dbbfcfab1}"
EXPECTED_PORTAL_TAG="sha-${EXPECTED_PORTAL_REF:0:7}"
EXPECTED_NEXTCLOUD_TAG="${NEXTCLOUD_TAG:-sha-693c013}"
EXPECTED_COLLABORA_TAG="${COLLABORA_TAG:-sha-8a7faae}"
source "${REPO}/scripts/lib/state.sh"

MASTER_PASSWORD="$(opensuite_read_master_password)" || exit 2
[ -n "${MASTER_PASSWORD}" ] || { echo "ERROR: master password must not be empty." >&2; exit 2; }
DOMAIN="$(cat /etc/mijnbureau/domain 2>/dev/null || true)"
[ -n "${DOMAIN}" ] || { echo "ERROR: /etc/mijnbureau/domain is missing." >&2; exit 2; }
opensuite_guard_install_identity "${DOMAIN}" "${MASTER_PASSWORD}"

if [ ! -d "${INFRA}/helmfile" ]; then
  echo "ERROR: no Helmfile checkout at ${INFRA} (set INFRA_DIR)." >&2
  exit 2
fi

probe_contains() { # command output on stdin, fixed string
  local needle="$1"
  grep -Fq "${needle}" && echo 1 || echo 0
}

probe_keycloak_theme() {
  kubectl -n mb-keycloak get sts keycloak-keycloak -o json 2>/dev/null \
    | probe_contains '/opt/bitnami/keycloak/themes/opensuite'
}

probe_element_image() {
  kubectl -n mb-element get deploy element-web \
    -o jsonpath='{.spec.template.spec.containers[?(@.name=="element-web")].image}' 2>/dev/null \
    | probe_contains 'ghcr.io/open-suite/element-web'
}

probe_meet_image() {
  kubectl -n mb-meet get deploy meet-frontend \
    -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null \
    | probe_contains 'ghcr.io/open-suite/meet-frontend'
}

probe_element_header() {
  kubectl -n mb-element get cm element-web-bureaublad-button \
    -o jsonpath='{.data.bureaublad-button\.js}' 2>/dev/null \
    | probe_contains 'Open Suite portal header'
}

probe_sidecar_headers() {
  local ns
  for ns in mb-nextcloud mb-grist mb-docs mb-bureaublad; do
    kubectl -n "${ns}" get cm opensuite-header-js \
      -o jsonpath='{.data.opensuite-header\.js}' 2>/dev/null \
      | grep -Fq 'Open Suite portal header' || { echo 0; return; }
  done
  echo 1
}

probe_portal_images() {
  local backend frontend
  backend="$(kubectl -n mb-bureaublad get deploy bureaublad-backend \
    -o jsonpath='{.spec.template.spec.containers[?(@.name=="backend")].image}' 2>/dev/null)"
  frontend="$(kubectl -n mb-bureaublad get deploy bureaublad-frontend \
    -o jsonpath='{.spec.template.spec.containers[?(@.name=="frontend")].image}' 2>/dev/null)"
  [ "${backend}" = "ghcr.io/open-suite/portal-api:${EXPECTED_PORTAL_TAG}" ] \
    && [ "${frontend}" = "ghcr.io/open-suite/portal-frontend:${EXPECTED_PORTAL_TAG}" ] \
    && echo 1 || echo 0
}

probe_nextcloud_image() {
  local image
  image="$(kubectl -n mb-nextcloud get deploy nextcloud \
    -o jsonpath='{.spec.template.spec.containers[?(@.name=="nextcloud")].image}' 2>/dev/null)"
  [ "${image}" = "ghcr.io/open-suite/nextcloud:${EXPECTED_NEXTCLOUD_TAG}" ] \
    && echo 1 || echo 0
}

probe_collabora_image() {
  local image
  image="$(kubectl -n mb-collabora get deploy collabora-online \
    -o jsonpath='{.spec.template.spec.containers[?(@.name=="collabora")].image}' 2>/dev/null)"
  [ "${image}" = "ghcr.io/open-suite/collabora:${EXPECTED_COLLABORA_TAG}" ] \
    && echo 1 || echo 0
}

probe_deck_calendar_default() {
  local value
  value="$(kubectl -n mb-nextcloud exec deploy/nextcloud -c nextcloud -- \
    sh -c 'cd /var/www/html && php occ config:app:get deck calendar' 2>/dev/null)"
  [ "${value}" = "no" ] && echo 1 || echo 0
}

expected_public_ip() {
  if [ -n "${OPEN_SUITE_PUBLIC_IP:-}" ]; then
    printf '%s' "${OPEN_SUITE_PUBLIC_IP}"
    return
  fi
  local ip
  ip="$(kubectl get node -o jsonpath='{.items[0].status.addresses[?(@.type=="ExternalIP")].address}' 2>/dev/null \
    | awk '{print $1}')"
  if [ -z "${ip}" ]; then
    ip="$(kubectl get node -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}' 2>/dev/null \
      | awk '{print $1}')"
  fi
  printf '%s' "${ip}"
}

probe_livekit_public_ip() {
  local expected config
  expected="$(expected_public_ip)"
  config="$(kubectl -n mb-livekit get cm livekit-server -o jsonpath='{.data.config\.yaml}' 2>/dev/null)"
  [ -n "${expected}" ] && grep -Fq "node_ip: ${expected}" <<<"${config}" && echo 1 || echo 0
}

probe_auth_gate() {
  local desired available image
  desired="$(kubectl -n mb-bureaublad get deploy opensuite-auth-gate \
    -o jsonpath='{.spec.replicas}' 2>/dev/null)"
  available="$(kubectl -n mb-bureaublad get deploy opensuite-auth-gate \
    -o jsonpath='{.status.availableReplicas}' 2>/dev/null)"
  image="$(kubectl -n mb-bureaublad get deploy opensuite-auth-gate \
    -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null)"
  [ -n "${desired}" ] && [ "${desired}" = "${available}" ] \
    && [ "${image}" = "${EXPECTED_AUTH_GATE_IMAGE}" ] && echo 1 || echo 0
}

probe_apex_redirect() {
  kubectl -n mb-bureaublad get ingress/apex-redirect middleware/apex-redirect >/dev/null 2>&1 \
    && echo 1 || echo 0
}

probe_networking() {
  local ns component policy selector destination_namespace destination_component port
  kubectl -n kube-system get cm coredns-custom >/dev/null 2>&1 || { echo 0; return; }
  for ns in mb-keycloak mb-grist mb-element mb-collabora mb-nextcloud \
            mb-livekit mb-meet mb-docs mb-messages mb-bureaublad; do
    kubectl -n "${ns}" get networkpolicy allow-egress-traefik >/dev/null 2>&1 \
      || { echo 0; return; }
  done
  while read -r ns component; do
    policy="allow-egress-keycloak-backchannel"
    selector="$(kubectl -n "${ns}" get networkpolicy "${policy}" \
      -o jsonpath='{.spec.podSelector.matchLabels.app\.kubernetes\.io/component}' 2>/dev/null)"
    destination_namespace="$(kubectl -n "${ns}" get networkpolicy "${policy}" \
      -o jsonpath='{.spec.egress[0].to[0].namespaceSelector.matchLabels.kubernetes\.io/metadata\.name}' 2>/dev/null)"
    destination_component="$(kubectl -n "${ns}" get networkpolicy "${policy}" \
      -o jsonpath='{.spec.egress[0].to[0].podSelector.matchLabels.app\.kubernetes\.io/component}' 2>/dev/null)"
    port="$(kubectl -n "${ns}" get networkpolicy "${policy}" \
      -o jsonpath='{.spec.egress[0].ports[0].port}' 2>/dev/null)"
    [ "${selector}" = "${component}" ] \
      && [ "${destination_namespace}" = "mb-keycloak" ] \
      && [ "${destination_component}" = "keycloak" ] \
      && [ "${port}" = "8080" ] || { echo 0; return; }
  done <<'EOF'
mb-bureaublad bureaublad-backend
mb-docs backend
mb-meet meet-backend
mb-messages backend
EOF
  echo 1
}

PROBES=(
  keycloak_theme
  element_image
  meet_image
  element_header
  sidecar_headers
  portal_images
  nextcloud_image
  collabora_image
  deck_calendar_default
  livekit_public_ip
  auth_gate
  apex_redirect
  networking
)

snapshot() {
  local p probe
  for p in "${PROBES[@]}"; do
    probe="probe_${p}"
    printf '%s=%s ' "${p}" "$("${probe}")"
  done
  echo
}

missing_from_snapshot() { # snapshot string
  local state="$1" p missing=""
  for p in "${PROBES[@]}"; do
    case " ${state} " in *" ${p}=1 "*) ;; *) missing="${missing} ${p}" ;; esac
  done
  printf '%s' "${missing}"
}

echo "== 1/5 baseline =="
BEFORE="$(snapshot)"
echo "  ${BEFORE}"
BASELINE_BROKEN="$(missing_from_snapshot "${BEFORE}")"
[ -z "${BASELINE_BROKEN}" ] || echo "  PRE-EXISTING DRIFT:${BASELINE_BROKEN}"

echo "== 2/5 Helmfile apply =="
APPLY_RC=1
for attempt in 1 2 3; do
  echo "  helmfile apply attempt ${attempt}/3"
  (
    cd "${INFRA}" || exit
    export MIJNBUREAU_MASTER_PASSWORD="${MASTER_PASSWORD}" MIJNBUREAU_CREATE_NAMESPACES=true
    helmfile -e demo apply --skip-diff-on-install
  )
  APPLY_RC=$?
  if [ "${APPLY_RC}" -eq 0 ]; then
    break
  fi
  if [ "${attempt}" -lt 3 ]; then
    echo "  helmfile apply failed; retrying the idempotent convergence apply in 15s"
    sleep 15
  fi
done
echo "  helmfile apply exit=${APPLY_RC}"

echo "== 3/5 post-apply snapshot =="
AFTER="$(snapshot)"
echo "  ${AFTER}"
REVERTED=""
for p in "${PROBES[@]}"; do
  b="$(tr ' ' '\n' <<<"${BEFORE}" | sed -n "s/^${p}=//p")"
  a="$(tr ' ' '\n' <<<"${AFTER}" | sed -n "s/^${p}=//p")"
  if [ "${b}" = "1" ] && [ "${a}" = "0" ]; then REVERTED="${REVERTED} ${p}"; fi
done
[ -z "${REVERTED}" ] || echo "  REVERTED BY APPLY:${REVERTED}"

echo "== 4/5 heal all remaining procedural state =="
OPEN_SUITE_DEMO_MODE="$(cat /etc/mijnbureau/demo-mode 2>/dev/null || echo false)"
OPEN_SUITE_DEMO_USERNAME="$(cat /etc/mijnbureau/demo-username 2>/dev/null || true)"
OPEN_SUITE_DEMO_PASSWORD="$(cat /etc/mijnbureau/demo-password 2>/dev/null || true)"
OPEN_SUITE_DEMO_ADMIN_USERNAME="$(cat /etc/mijnbureau/demo-admin-username 2>/dev/null || true)"
export OPEN_SUITE_DEMO_MODE OPEN_SUITE_DEMO_USERNAME OPEN_SUITE_DEMO_PASSWORD
export OPEN_SUITE_DEMO_ADMIN_USERNAME
export OPEN_SUITE_PUBLIC_IP="${OPEN_SUITE_PUBLIC_IP:-$(expected_public_ip)}"

capture_docs_workload_logs() {
  local step="$1" component pod
  [ -n "${OPEN_SUITE_CONVERGENCE_LOG_DIR:-}" ] || return 0

  for component in backend y-provider; do
    kubectl logs -n mb-docs "deployment/docs-${component}" \
      --all-pods=true --all-containers --prefix --tail=500 \
      >"${OPEN_SUITE_CONVERGENCE_LOG_DIR}/${step}-docs-${component}.log" 2>&1 || true
    kubectl get pods -n mb-docs \
      -l "app.kubernetes.io/component=${component},app.kubernetes.io/instance=docs" \
      -o name 2>/dev/null | while read -r pod; do
        [ -n "${pod}" ] || continue
        kubectl logs -n mb-docs "${pod}" --all-containers --prefix --tail=500 --previous \
          >"${OPEN_SUITE_CONVERGENCE_LOG_DIR}/${step}-${pod#pod/}.previous.log" 2>&1 || true
      done
  done
}

HEAL_FAILED=""
for step in 02-networking 03-restart-oidc-apps 04-nextcloud-office \
            08-open-suite-portal 09-portal-header 10-keycloak-login 12-auth-gate; do
  echo "  -> ${step}"
  step_rc=0
  if [ -n "${OPEN_SUITE_CONVERGENCE_LOG_DIR:-}" ]; then
    install -d -m 0755 "${OPEN_SUITE_CONVERGENCE_LOG_DIR}"
    bash "${DIR}/${step}.sh" \
      >"${OPEN_SUITE_CONVERGENCE_LOG_DIR}/${step}.log" 2>&1 \
      || step_rc=$?
  else
    bash "${DIR}/${step}.sh" >/dev/null 2>&1 || step_rc=$?
  fi
  if [ "${step_rc}" -ne 0 ]; then
    HEAL_FAILED="${HEAL_FAILED} ${step}"
    capture_docs_workload_logs "${step}"
  fi
done

echo "== 5/5 final snapshot =="
HEALED="$(snapshot)"
echo "  ${HEALED}"
STILL_BROKEN="$(missing_from_snapshot "${HEALED}")"
[ -z "${HEAL_FAILED}" ] || echo "  HEAL COMMANDS FAILED:${HEAL_FAILED}"
[ -z "${STILL_BROKEN}" ] || echo "  STILL BROKEN:${STILL_BROKEN}"

if [ "${APPLY_RC}" -ne 0 ]; then exit 2; fi
if [ -n "${HEAL_FAILED}" ] || [ -n "${STILL_BROKEN}" ]; then exit 1; fi
if [ -n "${BASELINE_BROKEN}" ]; then exit 4; fi
if [ -n "${REVERTED}" ]; then
  echo "  convergence verified after healing reported Helmfile drift:${REVERTED}"
else
  echo "  convergence verified without Helmfile drift"
fi
