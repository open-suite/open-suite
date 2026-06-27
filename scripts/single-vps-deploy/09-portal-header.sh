#!/usr/bin/env bash
# Usage: ./09-portal-header.sh
#
# Injects the shared Open Suite portal header (overlays/portal-header/
# opensuite-header.js) into every app so direct (non-portal) navigation still
# shows the Open Suite top bar. ONE asset, served same-origin everywhere.
#
# Two delivery paths, by how each app is served:
#   - Static SPAs that already inject a same-origin `<script src=
#     "/bureaublad-button.js">` tag (Meet, Element): we just overwrite that
#     file's contents with our shared header.
#   - Everything else — Nextcloud (strict CSP), Grist and Docs (which only load
#     the script cross-origin via app config, unreliably): an nginx sidecar
#     proxies the app and `sub_filter`s a same-origin <script> tag into the HTML.
#     For strict-CSP apps it copies the per-request CSP nonce onto the tag so it
#     runs under `script-src 'strict-dynamic' 'nonce-...'`.
#
# Idempotent and safe to re-run.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HEADER_JS="${REPO_ROOT}/overlays/portal-header/opensuite-header.js"
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
SIDECAR_PORT=8091

[ -f "${HEADER_JS}" ] || { echo "missing ${HEADER_JS}"; exit 1; }

# --- Static SPAs: overwrite the already-injected button file -----------------
patch_static() {
  local ns="$1" cm="$2"
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
  kubectl -n "$ns" rollout restart deploy >/dev/null 2>&1 || true
}

# --- Sidecar: proxy the app and sub_filter a same-origin <script> tag in -----
# add_sidecar <ns> <deploy> <svc> <upstream_port> <netpol>
# The sidecar listens on $SIDECAR_PORT, proxies to 127.0.0.1:<upstream_port>,
# serves the header same-origin, and stamps the CSP nonce (if any) on the tag.
add_sidecar() {
  local ns="$1" deploy="$2" svc="$3" upstream="$4" netpol="$5"
  echo "==> [${ns}] header sidecar on ${deploy} (proxy 127.0.0.1:${upstream})"
  # Content hash → cache-busting query. The asset is served `immutable` (cached
  # forever), so the only way a header update reaches browsers without a hard
  # refresh is a changed URL. ?v=<hash> changes exactly when the file changes.
  local ver
  ver=$(sha1sum "$HEADER_JS" | cut -c1-12)
  local conf
  conf=$(cat <<NGINX
worker_processes 1;
pid /tmp/nginx.pid;            # nginx-unprivileged runs as uid 101
events { worker_connections 1024; }
http {
  include /etc/nginx/mime.types;
  client_body_temp_path /tmp/client_temp;
  proxy_temp_path /tmp/proxy_temp;
  fastcgi_temp_path /tmp/fastcgi_temp;
  uwsgi_temp_path /tmp/uwsgi_temp;
  scgi_temp_path /tmp/scgi_temp;
  # Carry over the upstream CSP nonce so the injected script runs under
  # 'strict-dynamic' (e.g. Nextcloud); empty/harmless when there's no CSP.
  map \$upstream_http_content_security_policy \$ko_nonce {
    default "";
    "~nonce-(?<n>[A-Za-z0-9+/=_-]+)" \$n;
  }
  server {
    listen ${SIDECAR_PORT};
    client_max_body_size 0;
    location = /opensuite-header.js {
      default_type application/javascript;
      add_header Cache-Control "public, max-age=31536000, immutable";
      alias /usr/share/opensuite/opensuite-header.js;
    }
    location ~* \.(?:avif|css|gif|ico|jpe?g|js|mjs|png|svg|webp|woff2?)$ {
      proxy_pass http://127.0.0.1:${upstream};
      proxy_set_header Host \$host;
      proxy_set_header X-Real-IP \$remote_addr;
      proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto \$scheme;
      proxy_redirect off;
      proxy_hide_header Cache-Control;
      add_header Cache-Control "public, max-age=31536000, immutable";
    }
    location / {
      rewrite ^/apps/office/(documents|spreadsheets|presentations|diagrams)/?$ /apps/office/?koOfficeSection=\$1 break;
      proxy_pass http://127.0.0.1:${upstream};
      proxy_set_header Host \$host;
      proxy_set_header X-Real-IP \$remote_addr;
      proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto \$scheme;
      proxy_set_header Accept-Encoding "";   # so sub_filter can rewrite the body
      proxy_read_timeout 300s;
      proxy_redirect off;
      sub_filter '</body>' '<script nonce="\$ko_nonce" src="/opensuite-header.js?v=${ver}"></script></body>';
      sub_filter_once on;
    }
  }
}
NGINX
)
  local cm="opensuite-${deploy}-hdr"
  python3 - "$ns" "$cm" "$HEADER_JS" "$conf" <<'PY' | kubectl apply -f -
import json, sys
ns, cm, jspath, conf = sys.argv[1:5]
print(json.dumps({"apiVersion":"v1","kind":"ConfigMap",
  "metadata":{"name":cm,"namespace":ns},
  "data":{"nginx.conf":conf,"opensuite-header.js":open(jspath).read()}}))
PY

  kubectl -n "$ns" patch deploy "$deploy" --type strategic -p "{
    \"spec\":{\"template\":{\"spec\":{
      \"volumes\":[{\"name\":\"opensuite-header\",\"configMap\":{\"name\":\"${cm}\"}}],
      \"containers\":[{
        \"name\":\"opensuite-header\",
        \"image\":\"nginxinc/nginx-unprivileged:1.27-alpine\",
        \"ports\":[{\"containerPort\":${SIDECAR_PORT}}],
        \"volumeMounts\":[
          {\"name\":\"opensuite-header\",\"mountPath\":\"/etc/nginx/nginx.conf\",\"subPath\":\"nginx.conf\"},
          {\"name\":\"opensuite-header\",\"mountPath\":\"/usr/share/opensuite/opensuite-header.js\",\"subPath\":\"opensuite-header.js\"}
        ]
      }]
    }}}}"

  # Route the Service through the sidecar.
  kubectl -n "$ns" patch svc "$svc" --type json \
    -p "[{\"op\":\"replace\",\"path\":\"/spec/ports/0/targetPort\",\"value\":${SIDECAR_PORT}}]"

  # Admit the sidecar port in the NetworkPolicy (base policies pin the app port).
  kubectl -n "$ns" get netpol "$netpol" -o json | python3 -c "
import json, sys
o = json.load(sys.stdin); port = ${SIDECAR_PORT}
for rule in o['spec'].get('ingress', []):
    ports = rule.setdefault('ports', [])
    if not any(p.get('port') == port for p in ports):
        ports.append({'port': port, 'protocol': 'TCP'})
for k in ('creationTimestamp','resourceVersion','uid','managedFields','generation'):
    o.get('metadata',{}).pop(k, None)
print(json.dumps(o))
" | kubectl apply -f -

  # subPath mounts don't hot-reload — restart so config/header changes apply.
  kubectl -n "$ns" rollout restart deploy/"$deploy"
  kubectl -n "$ns" rollout status deploy/"$deploy" --timeout=180s
}

echo "==> [1/2] Static SPAs (already inject a same-origin tag)"
patch_static mb-meet    meet-static-files
patch_static mb-element element-web-bureaublad-button

echo "==> [2/2] Sidecar apps"
add_sidecar mb-nextcloud  nextcloud           nextcloud           8080 nextcloud
add_sidecar mb-grist      grist               grist               8484 grist
add_sidecar mb-docs       docs-frontend       docs-frontend       8080 docs-frontend
add_sidecar mb-bureaublad bureaublad-frontend bureaublad-frontend 8080 bureaublad-frontend

echo "==> Done — Open Suite header injected across apps"
