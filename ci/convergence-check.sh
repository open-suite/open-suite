#!/usr/bin/env bash
# Convergence check — the test the empty-demo/broken-Collabora incident was
# missing (PLAN.md Phase 1, ticket-class 3.6).
#
# The demo's history is a string of fixes that only ever lived as imperative
# cluster mutations (kubectl patch / occ / kcadm). A bare `helmfile -e demo
# apply` re-renders the workloads and silently reverts any fix not captured in
# a patch or values — which is exactly how a "clean redeploy" kept
# reintroducing bugs. This script makes that reversion visible on demand
# instead of by surprise months later:
#
#   1. snapshot the known imperative artifacts (must all be present to start)
#   2. run `helmfile -e demo apply` (the declarative layer only)
#   3. re-check — whatever reverted is imperative debt still owed to Phase 2
#   4. heal by re-running deploy.sh's imperative steps (09/10/11 …)
#   5. re-check — confirm the demo is whole again
#
# DESTRUCTIVE to the live demo while it runs (steps 2–4 take ~5–15 min and the
# demo is degraded in between). Run only in a maintenance window, on the box,
# as root. Per repo policy, report before and after touching the live server.
#
# Usage (on 95.217.109.206):
#   MASTER_PASSWORD=... ci/convergence-check.sh
#   ci/convergence-check.sh <master-password>
set -uo pipefail

MASTER_PASSWORD="${MASTER_PASSWORD:-${1:-}}"
if [ -z "${MASTER_PASSWORD}" ]; then
  echo "ERROR: master password required (MASTER_PASSWORD=... or as \$1)." >&2
  echo "It is the third arg deploy.sh was run with; not stored in this repo." >&2
  exit 2
fi

export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
INFRA="${INFRA_DIR:-/root/mijn-bureau-infra}"
DIR="${REPO}/scripts/single-vps-deploy"

if [ ! -d "${INFRA}/helmfile" ]; then
  echo "ERROR: no helmfile checkout at ${INFRA} (set INFRA_DIR). Run deploy.sh once first." >&2
  exit 2
fi

# --- the imperative artifacts a bare helmfile apply reverts ------------------
# Each probe echoes "1" if the fix is present, "0" if reverted. Add a probe
# here when a new imperative fix lands, so this check keeps pace with the debt.
probe_keycloak_theme() {   # 10-keycloak-login.sh: kubectl patch sts (theme volume mount)
  kubectl -n mb-keycloak get sts keycloak-keycloak -o json 2>/dev/null \
    | grep -c '/opt/bitnami/keycloak/themes/opensuite' | head -c1
}
probe_element_bundle() {   # 11-element-web.sh: kubectl patch deploy (bundle-patch initContainer)
  local n
  n=$(kubectl -n mb-element get deploy element-web \
        -o jsonpath='{.spec.template.spec.initContainers}' 2>/dev/null)
  [ -n "${n}" ] && [ "${n}" != "[]" ] && echo 1 || echo 0
}
probe_meet_header() {      # 09-portal-header.sh: patch_static overwrites the cm data key
  kubectl -n mb-meet get cm meet-static-files \
    -o jsonpath='{.data.bureaublad-button\.js}' 2>/dev/null \
    | grep -qc 'Open Suite portal header' && echo 1 || echo 0
}
probe_element_header() {   # 09-portal-header.sh: patch_static (element)
  kubectl -n mb-element get cm element-web-bureaublad-button \
    -o jsonpath='{.data.bureaublad-button\.js}' 2>/dev/null \
    | grep -qc 'Open Suite portal header' && echo 1 || echo 0
}

PROBES="keycloak_theme element_bundle meet_header element_header"

snapshot() {  # prints "name=0/1" per probe
  local p
  for p in ${PROBES}; do printf '%s=%s ' "${p}" "$(probe_${p})"; done
  echo
}

echo "== 1/5 baseline (before apply) =="
BEFORE="$(snapshot)"; echo "  ${BEFORE}"
for p in ${PROBES}; do
  case " ${BEFORE} " in *" ${p}=1 "*) ;; *)
    echo "  WARN: ${p} is already reverted before we started — heal the demo first." ;;
  esac
done

echo "== 2/5 helmfile -e demo apply (declarative layer only) =="
( cd "${INFRA}" \
  && export MIJNBUREAU_MASTER_PASSWORD="${MASTER_PASSWORD}" MIJNBUREAU_CREATE_NAMESPACES=true \
  && helmfile -e demo apply --skip-diff-on-install )
APPLY_RC=$?
echo "  helmfile apply exit=${APPLY_RC}"

echo "== 3/5 after bare apply — what reverted? =="
AFTER="$(snapshot)"; echo "  ${AFTER}"
REVERTED=""
for p in ${PROBES}; do
  b=$(printf '%s' "${BEFORE}" | tr ' ' '\n' | sed -n "s/^${p}=//p")
  a=$(printf '%s' "${AFTER}"  | tr ' ' '\n' | sed -n "s/^${p}=//p")
  if [ "${b}" = "1" ] && [ "${a}" = "0" ]; then REVERTED="${REVERTED} ${p}"; fi
done
if [ -n "${REVERTED}" ]; then
  echo "  IMPERATIVE DEBT (reverted by a bare apply):${REVERTED}"
  echo "  → each of these must move into a patch/values/image (PLAN.md Phase 2)."
else
  echo "  none reverted — the declarative layer converges. Phase 2 debt cleared."
fi

echo "== 4/5 heal — re-run the imperative deploy steps =="
export OPEN_SUITE_DEMO_MODE="$(cat /etc/mijnbureau/demo-mode 2>/dev/null || echo false)"
export OPEN_SUITE_DEMO_USERNAME="$(cat /etc/mijnbureau/demo-username 2>/dev/null || true)"
export OPEN_SUITE_DEMO_PASSWORD="$(cat /etc/mijnbureau/demo-password 2>/dev/null || true)"
export OPEN_SUITE_DEMO_ADMIN_USERNAME="$(cat /etc/mijnbureau/demo-admin-username 2>/dev/null || true)"
for step in 03-restart-oidc-apps 04-nextcloud-office 08-open-suite-portal \
            09-portal-header 10-keycloak-login 11-element-web; do
  echo "  -> ${step}"
  bash "${DIR}/${step}.sh" >/dev/null 2>&1 || echo "     WARN: ${step} exited nonzero"
done

echo "== 5/5 after heal — is the demo whole again? =="
HEALED="$(snapshot)"; echo "  ${HEALED}"
STILL_BROKEN=""
for p in ${PROBES}; do
  case " ${HEALED} " in *" ${p}=1 "*) ;; *) STILL_BROKEN="${STILL_BROKEN} ${p}" ;; esac
done
if [ -n "${STILL_BROKEN}" ]; then
  echo "  STILL BROKEN after heal:${STILL_BROKEN} — the demo needs manual attention."
  exit 1
fi
echo "  demo restored. Run the authenticated smoke to confirm end-to-end."
[ -n "${REVERTED}" ] && exit 3 || exit 0
