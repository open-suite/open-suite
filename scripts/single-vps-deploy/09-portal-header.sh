#!/usr/bin/env bash
# Usage: ./09-portal-header.sh
#
# Injects the shared Keep Office portal header (overlays/portal-header/
# keepoffice-header.js) into every app so direct (non-portal) navigation still
# shows the Keep Office top bar. ONE asset, served same-origin everywhere.
#
# Two delivery paths, by how each app is served:
#   - Static SPAs (Meet, Element, Docs, Grist): the MinBZK base already injects
#     a `<script src="/bureaublad-button.js">` tag served by a static-nginx
#     sidecar. We just overwrite that file's contents with our shared header.
#   - Nextcloud (server-rendered PHP, strict CSP `script-src 'self'`): we add an
#     nginx sidecar that proxies the app and `sub_filter`s the script tag in,
#     serving the JS same-origin so it satisfies the CSP. Replaces MinBZK's
#     per-app custom NC button app.
#
# Idempotent and safe to re-run.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HEADER_JS="${REPO_ROOT}/overlays/portal-header/keepoffice-header.js"
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

[ -f "${HEADER_JS}" ] || { echo "missing ${HEADER_JS}"; exit 1; }

# Replace the data key of an existing ConfigMap with our header file content.
# Used for the static SPAs, whose configmaps carry a single bureaublad-button.js
# key that the base's nginx already serves and injects.
patch_static() {
  local ns="$1" cm="$2"
  echo "==> [${ns}] injecting header into ${cm}"
  python3 - "$ns" "$cm" "$HEADER_JS" <<'PY' | kubectl apply -f -
import json, subprocess, sys
ns, cm, path = sys.argv[1], sys.argv[2], sys.argv[3]
js = open(path).read()
obj = json.loads(subprocess.check_output(["kubectl","-n",ns,"get","cm",cm,"-o","json"]))
obj["data"]["bureaublad-button.js"] = js
for k in ("creationTimestamp","resourceVersion","uid","managedFields"):
    obj.get("metadata",{}).pop(k, None)
print(json.dumps(obj))
PY
  kubectl -n "$ns" rollout restart deploy >/dev/null 2>&1 || true
}

echo "==> [1/3] Static SPAs"
patch_static mb-meet    meet-static-files
patch_static mb-element element-web-bureaublad-button
patch_static mb-docs    docs-static-files
patch_static mb-grist   grist-static-files

echo "==> [2/3] Nextcloud sidecar (proxy + sub_filter, same-origin header)"
# ConfigMap: nginx.conf (proxy NC on :8081, inject script, serve the JS) + the JS.
NGINX_CONF=$(cat <<'NGINX'
worker_processes 1;
events { worker_connections 1024; }
http {
  include /etc/nginx/mime.types;
  server {
    listen 8081;
    client_max_body_size 0;
    location = /keepoffice-header.js {
      default_type application/javascript;
      alias /usr/share/keepoffice/keepoffice-header.js;
    }
    location / {
      proxy_pass http://127.0.0.1:8080;
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
      # Disable upstream compression so sub_filter can rewrite the HTML body.
      proxy_set_header Accept-Encoding "";
      proxy_read_timeout 300s;
      proxy_redirect off;
      sub_filter '</body>' '<script src="/keepoffice-header.js"></script></body>';
      sub_filter_once on;
    }
  }
}
NGINX
)
python3 - "$HEADER_JS" "$NGINX_CONF" <<'PY' | kubectl apply -f -
import json, sys
js = open(sys.argv[1]).read(); conf = sys.argv[2]
cm = {"apiVersion":"v1","kind":"ConfigMap",
      "metadata":{"name":"keepoffice-nc-header","namespace":"mb-nextcloud"},
      "data":{"nginx.conf":conf,"keepoffice-header.js":js}}
print(json.dumps(cm))
PY

# Add the sidecar container + volume (idempotent: replaces if already present).
kubectl -n mb-nextcloud patch deploy nextcloud --type strategic -p '{
  "spec":{"template":{"spec":{
    "volumes":[{"name":"keepoffice-header","configMap":{"name":"keepoffice-nc-header"}}],
    "containers":[{
      "name":"keepoffice-header",
      "image":"nginxinc/nginx-unprivileged:1.27-alpine",
      "ports":[{"containerPort":8081}],
      "volumeMounts":[
        {"name":"keepoffice-header","mountPath":"/etc/nginx/nginx.conf","subPath":"nginx.conf"},
        {"name":"keepoffice-header","mountPath":"/usr/share/keepoffice/keepoffice-header.js","subPath":"keepoffice-header.js"}
      ]
    }]
  }}}}'

# Point the Nextcloud Service at the sidecar so ingress traffic flows through it.
kubectl -n mb-nextcloud patch svc nextcloud --type json \
  -p '[{"op":"replace","path":"/spec/ports/0/targetPort","value":8081}]'

kubectl -n mb-nextcloud rollout status deploy/nextcloud --timeout=180s

echo "==> [3/3] Done — Keep Office header injected across apps"
