#!/usr/bin/env bash
# Usage: ./09-portal-header.sh
#
# Publishes the shared Open Suite portal header (overlays/portal-header/
# opensuite-header.js) into every app so direct (non-portal) navigation still
# shows the Open Suite top bar. ONE asset, served same-origin everywhere.
#
# Two delivery paths, by how each app is served:
#   - Element already injects a same-origin `/bureaublad-button.js` tag: we
#     overwrite that configmap file's contents with our shared header.
#   - Meet carries `/opensuite-header.js` in the Open Suite frontend image.
#   - Nextcloud, Grist, Docs, Bureaublad: an nginx sidecar proxies the app and
#     sub_filters a same-origin <script> tag into the HTML. The sidecar itself
#     is DECLARATIVE — patches/local/opensuite-header-sidecar.patch adds the
#     container, service reroute (:8091) and NetworkPolicy port to the vendored
#     charts, so `helmfile apply` owns it. This script only uploads the header
#     JS into the `opensuite-header-js` configmap each sidecar dir-mounts
#     (optional: pages render headerless until this runs; kubelet syncs the
#     mount in ~1 min, no restart needed).
#
# Idempotent and safe to re-run.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HEADER_JS="${REPO_ROOT}/overlays/portal-header/opensuite-header.js"
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

[ -f "${HEADER_JS}" ] || { echo "missing ${HEADER_JS}"; exit 1; }

# Gate the Mail nav item on the messages app actually being deployed: flip the
# MAIL_ENABLED flag in a temp copy so the shipped asset stays link-dead-free
# when application.messages is off.
if kubectl get deploy -n mb-messages messages-frontend >/dev/null 2>&1; then
  TMP_HEADER="$(mktemp)"
  sed 's/var MAIL_ENABLED = false;/var MAIL_ENABLED = true;/' "${HEADER_JS}" > "${TMP_HEADER}"
  HEADER_JS="${TMP_HEADER}"
  echo "==> messages app detected — enabling the Mail nav item"
fi

# --- Static SPAs: overwrite the already-injected button file -----------------
# patch_static <ns> <cm> <deploy...> — restarts exactly the deployments that
# mount the configmap and waits for each.
patch_static() {
  local ns="$1" cm="$2"; shift 2
  echo "==> [${ns}] injecting header into ${cm}"
  python3 - "$ns" "$cm" "$HEADER_JS" <<'PY' | kubectl apply -f -
import json, subprocess, sys
ns, cm, path = sys.argv[1], sys.argv[2], sys.argv[3]
obj = json.loads(subprocess.check_output(["kubectl","-n",ns,"get","cm",cm,"-o","json"]))
obj["data"]["bureaublad-button.js"] = open(path).read()
for k in ("creationTimestamp","resourceVersion","uid","managedFields"):
    obj.get("metadata",{}).pop(k, None)
print(json.dumps(obj))
PY
  local d
  for d in "$@"; do
    kubectl -n "$ns" rollout restart "deploy/${d}"
    kubectl -n "$ns" rollout status "deploy/${d}" --timeout=180s
  done
}

# --- Sidecar apps: upload the header JS the declarative sidecar serves -------
upload_header_js() {
  local ns="$1"
  echo "==> [${ns}] uploading opensuite-header-js"
  python3 - "$ns" "$HEADER_JS" <<'PY' | kubectl apply -f -
import json, sys
ns, jspath = sys.argv[1], sys.argv[2]
print(json.dumps({"apiVersion":"v1","kind":"ConfigMap",
  "metadata":{"name":"opensuite-header-js","namespace":ns,
    "labels":{"app.kubernetes.io/part-of":"open-suite",
              "app.kubernetes.io/component":"opensuite-header"}},
  "data":{"opensuite-header.js":open(jspath).read()}}))
PY
}

echo "==> [1/2] Element static SPA (already injects a same-origin tag)"
# Meet's header ships inside the meet-frontend SPA bundle (patches/meet), served
# on meet.<domain>; the old meet-static-files injection only reached
# meet-static-nginx on the unused static-meet.<domain> host, so it did nothing.
patch_static mb-element element-web-bureaublad-button element-web

echo "==> [2/2] Header JS for the sidecar apps"
upload_header_js mb-nextcloud
upload_header_js mb-grist
upload_header_js mb-docs
upload_header_js mb-bureaublad
# Optional app: only when the messages namespace exists (its own chart carries
# the header sidecar; this uploads the JS it serves).
if kubectl get ns mb-messages >/dev/null 2>&1; then
  upload_header_js mb-messages
fi

echo "==> Done — header published (sidecars pick up configmap changes within ~1 min)"
