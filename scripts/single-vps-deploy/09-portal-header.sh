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

# NOTE: the Element sync-cache migration is intentionally left OFF. It deleted
# Element's browser-side sync database on load, which forces a full re-sync
# ("Connecting to chat" splash + a reload + a slow first load) for every
# returning user each time the id was bumped — too heavy a cost for the demo.
# The seed no longer recreates rooms (it purges history in a stable room), so
# clients reconcile normally. Anyone who cached pre-purge duplicates can clear
# them once via Element's own Settings → Help & About → Clear cache and reload.

# Stamp the generated deployment-specific asset. The runtime uses this hash to
# replace a stale header that an old app image may have mounted first.
HEADER_VERSION="$(sha256sum "${HEADER_JS}" | cut -c1-12)"
sed -i "s/var HEADER_VERSION = \"source\";/var HEADER_VERSION = \"${HEADER_VERSION}\";/" "${HEADER_JS}"
echo "==> publishing shared header ${HEADER_VERSION}"

echo "==> Discovering and publishing every shared-header asset"
python3 - "$HEADER_JS" <<'PY'
import json
import re
import subprocess
import sys
import tempfile
import time

header = open(sys.argv[1]).read()
configmaps = json.loads(
    subprocess.check_output(["kubectl", "get", "configmap", "-A", "-o", "json"])
)["items"]
deployments = json.loads(
    subprocess.check_output(["kubectl", "get", "deployment", "-A", "-o", "json"])
)["items"]
existing_configmaps = {
    (configmap["metadata"]["namespace"], configmap["metadata"]["name"])
    for configmap in configmaps
}

# Map each ConfigMap to the deployments that mount it. Only a mounted legacy
# asset is a header target; this avoids rewriting unrelated historical data.
consumers = {}
live_mounts = {}
for deployment in deployments:
    namespace = deployment["metadata"]["namespace"]
    name = deployment["metadata"]["name"]
    pod_spec = deployment.get("spec", {}).get("template", {}).get("spec", {})
    volumes = pod_spec.get("volumes", [])
    volume_configmaps = {}
    for volume in volumes:
        configmap = (volume.get("configMap") or {}).get("name")
        if configmap:
            volume_configmaps[volume["name"]] = configmap
            consumers.setdefault((namespace, configmap), set()).add(name)
    for container in pod_spec.get("containers", []):
        for mount in container.get("volumeMounts", []):
            configmap = volume_configmaps.get(mount["name"])
            if configmap:
                live_mounts.setdefault((namespace, configmap), set()).add((
                    name,
                    container["name"],
                    mount["mountPath"],
                    mount.get("subPath"),
                ))

# A sidecar ConfigMap is intentionally optional so Helm can install the apps
# before this procedural publication step. On a genuinely fresh cluster that
# means the mounted ConfigMap does not exist yet. Create only the exact standard
# name referenced by a live volume; never materialize arbitrary missing refs.
sidecar_configmaps = {
    (namespace, name)
    for namespace, name in live_mounts
    if name == "opensuite-header-js"
}
for namespace, name in sorted(sidecar_configmaps - existing_configmaps):
    manifest = {
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": {
            "name": name,
            "namespace": namespace,
            "labels": {
                "app.kubernetes.io/component": "opensuite-header",
                "app.kubernetes.io/part-of": "open-suite",
                "opensuite.online/shared-header": "true",
            },
        },
    }
    subprocess.run(
        ["kubectl", "create", "-f", "-"],
        input=json.dumps(manifest),
        text=True,
        check=True,
    )
    print(f"==> [{namespace}] created mounted ConfigMap {name}")

targets = {
    (namespace, name, "opensuite-header.js"): set()
    for namespace, name in sidecar_configmaps
}
for configmap in configmaps:
    namespace = configmap["metadata"]["namespace"]
    name = configmap["metadata"]["name"]
    data = configmap.get("data") or {}
    mounted_by = consumers.get((namespace, name), set())
    if "opensuite-header.js" in data:
        targets[(namespace, name, "opensuite-header.js")] = set()
    elif "bureaublad-button.js" in data and mounted_by:
        targets[(namespace, name, "bureaublad-button.js")] = mounted_by

if not targets:
    raise SystemExit("no shared-header ConfigMaps discovered")

restarts = set()
convergence_checks = set()
for (namespace, name, key), mounted_by in sorted(targets.items()):
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
    else:
        for deployment, container, mount_path, sub_path in live_mounts.get((namespace, name), set()):
            live_path = mount_path if sub_path else f"{mount_path.rstrip('/')}/{key}"
            convergence_checks.add((namespace, deployment, container, live_path))

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

version_match = re.search(r'var HEADER_VERSION = "([^"]+)";', header)
if not version_match:
    raise SystemExit("generated header has no version stamp")
version_marker = f'var HEADER_VERSION = "{version_match.group(1)}";'
deadline = time.monotonic() + 120
pending = sorted(convergence_checks)
while pending and time.monotonic() < deadline:
    still_pending = []
    for namespace, deployment, container, live_path in pending:
        result = subprocess.run([
            "kubectl", "-n", namespace, "exec", f"deployment/{deployment}",
            "-c", container, "--", "grep", "-Fq", version_marker, live_path,
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if result.returncode:
            still_pending.append((namespace, deployment, container, live_path))
    pending = still_pending
    if pending:
        time.sleep(3)
if pending:
    locations = ", ".join(f"{ns}/{deployment}:{container}" for ns, deployment, container, _ in pending)
    raise SystemExit(f"header ConfigMap did not converge within 120s: {locations}")

print(f"==> Verified {len(convergence_checks)} live sidecar mounts at the published version")
print(f"==> Published {len(targets)} shared-header assets; restarted {len(restarts)} consumers")
PY

echo "==> Done — one canonical header published cluster-wide"
