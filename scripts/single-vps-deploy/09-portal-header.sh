#!/usr/bin/env bash
# Usage: ./09-portal-header.sh
#
# Publishes the shared Open Suite portal header (overlays/portal-header/
# opensuite-header.js) into every app so direct (non-portal) navigation still
# shows the Open Suite top bar. ONE asset, served same-origin everywhere.
#
# Apps expose one of two same-origin asset keys through a ConfigMap:
#   - `opensuite-header.js`: directory-mounted into an nginx header sidecar.
#   - `bureaublad-button.js`: injected by an existing SPA init container.
#
# This script discovers both keys cluster-wide and publishes the same generated
# asset to every consumer. There is deliberately no app or namespace list here:
# adding an app means mounting one of these standard assets, not copying the nav
# or remembering to extend this deploy script. Legacy SPA consumers are rolled
# after their ConfigMap changes; sidecar directory mounts update in place.
#
# Idempotent and safe to re-run.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HEADER_SOURCE="${REPO_ROOT}/overlays/portal-header/opensuite-header.js"
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

[ -f "${HEADER_SOURCE}" ] || { echo "missing ${HEADER_SOURCE}"; exit 1; }

# Work on a generated copy: app availability and demo-only migrations are
# deployment facts, not defaults that should be baked into the shared source.
HEADER_JS="$(mktemp)"
trap 'rm -f "${HEADER_JS}"' EXIT
cp "${HEADER_SOURCE}" "${HEADER_JS}"

# Gate the Mail nav item on the messages app actually being deployed: flip the
# MAIL_ENABLED flag in a temp copy so the shipped asset stays link-dead-free
# when application.messages is off.
if kubectl get deploy -n mb-messages messages-frontend >/dev/null 2>&1; then
  sed -i 's/var MAIL_ENABLED = false;/var MAIL_ENABLED = true;/' "${HEADER_JS}"
  echo "==> messages app detected — enabling the Mail nav item"
fi

# The old demo reset recreated Matrix rooms, leaving now-purged room copies in
# Element's browser-side sync database. Production deployments never ran that
# reset, so scope the one-time resync to clusters carrying the demo seed.
if kubectl get secret -n mb-bureaublad demo-seed >/dev/null 2>&1; then
  sed -i 's/var ELEMENT_SYNC_MIGRATION = "";/var ELEMENT_SYNC_MIGRATION = "stable-demo-dm-v1";/' "${HEADER_JS}"
  echo "==> demo seed detected — enabling the one-time Element sync migration"
fi

# Stamp the generated deployment-specific asset. The runtime uses this hash to
# replace a stale header that an old app image may have mounted first.
HEADER_VERSION="$(sha256sum "${HEADER_JS}" | cut -c1-12)"
sed -i "s/var HEADER_VERSION = \"source\";/var HEADER_VERSION = \"${HEADER_VERSION}\";/" "${HEADER_JS}"
echo "==> publishing shared header ${HEADER_VERSION}"

echo "==> Discovering and publishing every shared-header asset"
python3 - "$HEADER_JS" <<'PY'
import json
import subprocess
import sys
import tempfile

header = open(sys.argv[1]).read()
configmaps = json.loads(
    subprocess.check_output(["kubectl", "get", "configmap", "-A", "-o", "json"])
)["items"]
deployments = json.loads(
    subprocess.check_output(["kubectl", "get", "deployment", "-A", "-o", "json"])
)["items"]

# Map each ConfigMap to the deployments that mount it. Only a mounted legacy
# asset is a header target; this avoids rewriting unrelated historical data.
consumers = {}
for deployment in deployments:
    namespace = deployment["metadata"]["namespace"]
    name = deployment["metadata"]["name"]
    volumes = deployment.get("spec", {}).get("template", {}).get("spec", {}).get("volumes", [])
    for volume in volumes:
        configmap = (volume.get("configMap") or {}).get("name")
        if configmap:
            consumers.setdefault((namespace, configmap), set()).add(name)

targets = []
for configmap in configmaps:
    namespace = configmap["metadata"]["namespace"]
    name = configmap["metadata"]["name"]
    data = configmap.get("data") or {}
    mounted_by = consumers.get((namespace, name), set())
    if "opensuite-header.js" in data:
        targets.append((namespace, name, "opensuite-header.js", set()))
    elif "bureaublad-button.js" in data and mounted_by:
        targets.append((namespace, name, "bureaublad-button.js", mounted_by))

if not targets:
    raise SystemExit("no shared-header ConfigMaps discovered")

restarts = set()
for namespace, name, key, mounted_by in sorted(targets):
    patch = {
        "metadata": {"labels": {"opensuite.online/shared-header": "true"}},
        "data": {key: header},
    }
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json") as patch_file:
        json.dump(patch, patch_file)
        patch_file.flush()
        subprocess.check_call([
            "kubectl", "-n", namespace, "patch", "configmap", name,
            "--type=merge", "--patch-file", patch_file.name,
        ])
    print(f"==> [{namespace}] published {name}/{key}")
    if key == "bureaublad-button.js":
        restarts.update((namespace, deployment) for deployment in mounted_by)

for namespace, deployment in sorted(restarts):
    print(f"==> [{namespace}] restarting deployment/{deployment}")
    subprocess.check_call([
        "kubectl", "-n", namespace, "rollout", "restart", f"deployment/{deployment}"
    ])
for namespace, deployment in sorted(restarts):
    subprocess.check_call([
        "kubectl", "-n", namespace, "rollout", "status", f"deployment/{deployment}",
        "--timeout=180s",
    ])

print(f"==> Published {len(targets)} shared-header assets; restarted {len(restarts)} consumers")
PY

echo "==> Done — one canonical header published cluster-wide"
