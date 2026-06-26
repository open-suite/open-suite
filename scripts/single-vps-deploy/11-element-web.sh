#!/usr/bin/env bash
# Usage: ./11-element-web.sh
#
# Open Suite disables default room encryption for a Slack-like chat experience.
# Element Web 1.12.21 still registers device-verification reminder toasts from
# its static bundle, and the old config feature flag was removed upstream. Patch
# the shipped app bundle before nginx serves it so the reminders are never
# registered in the UI.
set -euo pipefail

export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

NS=mb-element
DEPLOY=element-web
APP_VOLUME=element-web-patched-app

IMAGE="$(kubectl -n "${NS}" get deploy "${DEPLOY}" -o jsonpath='{.spec.template.spec.containers[?(@.name=="element-web")].image}')"
[ -n "${IMAGE}" ] || { echo "could not resolve Element Web image"; exit 1; }

echo "==> Patching Element Web verification reminders at source (${IMAGE})"

INIT_SCRIPT="$(cat <<'SCRIPT'
set -eu

cp -R /app/. /patched/
js="$(find /patched/bundles -name element-web-app.js | head -1)"
[ -n "${js}" ] || { echo "element-web-app.js not found" >&2; exit 1; }

grep -F 'F.A.sharedInstance().addOrReplaceToast({key:Ge,title:$e(e),' "${js}" >/dev/null
grep -F 'r.size>0&&o&&!c?at(r):F.A.sharedInstance().dismissToast(rt)' "${js}" >/dev/null
grep -F 'for(const e of a)kt(e);' "${js}" >/dev/null
grep -F 'this.setStateForNewView({view:cR.A.COMPLETE_SECURITY})' "${js}" >/dev/null
grep -F 'this.setStateForNewView({view:cR.A.E2E_SETUP})' "${js}" >/dev/null

perl -0pi -e '
  s/F\.A\.sharedInstance\(\)\.addOrReplaceToast\(\{key:Ge,title:\$e\(e\),/"verify_this_session"===e?F.A.sharedInstance().dismissToast(Ge):F.A.sharedInstance().addOrReplaceToast({key:Ge,title:\$e(e),/g;
  s/r\.size>0&&o&&!c\?at\(r\):F\.A\.sharedInstance\(\)\.dismissToast\(rt\)/F.A.sharedInstance().dismissToast(rt)/g;
  s/for\(const e of a\)kt\(e\);/for(const e of a)void e;/g;
  s/0==f\.r\.instance\.extensions\.cryptoSetup\.SHOW_ENCRYPTION_SETUP_UI\?this\.onShowPostLoginScreen\(\):this\.setStateForNewView\(\{view:cR\.A\.COMPLETE_SECURITY\}\)/this.onShowPostLoginScreen()/g;
  s/XC\.sharedInstance\(\)\.startInitialCryptoSetup\(e,this\.onCompleteSecurityE2eSetupFinished\),this\.setStateForNewView\(\{view:cR\.A\.E2E_SETUP\}\)/this.onShowPostLoginScreen()/g;
  s/t\?this\.setStateForNewView\(\{view:cR\.A\.COMPLETE_SECURITY\}\):this\.onShowPostLoginScreen\(\)/this.onShowPostLoginScreen()/g;
' "${js}"

grep -F '"verify_this_session"===e?F.A.sharedInstance().dismissToast(Ge)' "${js}" >/dev/null
! grep -F 'r.size>0&&o&&!c?at(r):F.A.sharedInstance().dismissToast(rt)' "${js}" >/dev/null
! grep -F 'for(const e of a)kt(e);' "${js}" >/dev/null
! grep -F 'this.setStateForNewView({view:cR.A.COMPLETE_SECURITY})' "${js}" >/dev/null
! grep -F 'this.setStateForNewView({view:cR.A.E2E_SETUP})' "${js}" >/dev/null
SCRIPT
)"

PATCH_JSON="$(python3 - "${IMAGE}" "${APP_VOLUME}" "${INIT_SCRIPT}" <<'PY'
import json
import sys

image, volume, script = sys.argv[1:4]
print(json.dumps({
    "spec": {
        "template": {
            "spec": {
                "volumes": [{"name": volume, "emptyDir": {}}],
                "initContainers": [{
                    "name": "patch-element-web-app",
                    "image": image,
                    "imagePullPolicy": "Always",
                    "command": ["/bin/sh", "-c"],
                    "args": [script],
                    "volumeMounts": [{"name": volume, "mountPath": "/patched"}],
                }],
                "containers": [{
                    "name": "element-web",
                    "volumeMounts": [{"name": volume, "mountPath": "/app"}],
                }],
            },
        },
    },
}))
PY
)"

kubectl -n "${NS}" patch deploy "${DEPLOY}" --type strategic -p "${PATCH_JSON}"
kubectl -n "${NS}" rollout restart deploy/"${DEPLOY}"
kubectl -n "${NS}" rollout status deploy/"${DEPLOY}" --timeout=180s

echo "==> Done - Element Web verification reminders disabled before render"
