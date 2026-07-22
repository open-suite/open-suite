#!/usr/bin/env bash
# Exercise first-install shared-header discovery with a fake Kubernetes API.
# Sidecar ConfigMaps are absent from the fixture exactly as they are before the
# first 09-portal-header run on a fresh cluster.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT
export FIXTURE_DIR="${TMP}/fixture"
export OPERATIONS="${TMP}/operations.jsonl"
mkdir -p "${TMP}/bin" "${FIXTURE_DIR}"

cat > "${FIXTURE_DIR}/configmaps.json" <<'JSON'
{
  "items": [
    {
      "metadata": {"namespace": "mb-docs", "name": "opensuite-header-js"},
      "data": {"opensuite-header.js": "old sidecar header"}
    },
    {
      "metadata": {"namespace": "mb-element", "name": "element-web-bureaublad-button"},
      "data": {"bureaublad-button.js": "old legacy header"}
    },
    {
      "metadata": {"namespace": "mb-existing", "name": "historical-shared-header"},
      "data": {"opensuite-header.js": "old published header"}
    },
    {
      "metadata": {"namespace": "mb-ignored", "name": "unmounted-legacy"},
      "data": {"bureaublad-button.js": "unrelated data"}
    }
  ]
}
JSON

cat > "${FIXTURE_DIR}/deployments.json" <<'JSON'
{
  "items": [
    {
      "metadata": {"namespace": "mb-nextcloud", "name": "nextcloud"},
      "spec": {"template": {"spec": {
        "volumes": [{"name": "header", "configMap": {"name": "opensuite-header-js", "optional": true}}],
        "containers": [{"name": "opensuite-header", "volumeMounts": [{"name": "header", "mountPath": "/usr/share/opensuite"}]}]
      }}}
    },
    {
      "metadata": {"namespace": "mb-grist", "name": "grist"},
      "spec": {"template": {"spec": {
        "volumes": [{"name": "opensuite-header-js", "configMap": {"name": "opensuite-header-js", "optional": true}}],
        "containers": [{"name": "opensuite-header", "volumeMounts": [{"name": "opensuite-header-js", "mountPath": "/usr/share/opensuite"}]}]
      }}}
    },
    {
      "metadata": {"namespace": "mb-docs", "name": "docs-frontend"},
      "spec": {"template": {"spec": {
        "volumes": [{"name": "opensuite-header-js", "configMap": {"name": "opensuite-header-js", "optional": true}}],
        "containers": [{"name": "opensuite-header", "volumeMounts": [{"name": "opensuite-header-js", "mountPath": "/usr/share/opensuite"}]}]
      }}}
    },
    {
      "metadata": {"namespace": "mb-element", "name": "element-web"},
      "spec": {"template": {"spec": {
        "volumes": [{"name": "legacy", "configMap": {"name": "element-web-bureaublad-button"}}],
        "containers": [{"name": "element-web", "volumeMounts": [{"name": "legacy", "mountPath": "/legacy.js", "subPath": "bureaublad-button.js"}]}]
      }}}
    },
    {
      "metadata": {"namespace": "mb-ignored", "name": "unrelated"},
      "spec": {"template": {"spec": {
        "volumes": [{"name": "header", "configMap": {"name": "unrelated-missing", "optional": true}}],
        "containers": [{"name": "sidecar", "volumeMounts": [{"name": "header", "mountPath": "/unrelated"}]}]
      }}}
    }
  ]
}
JSON

cat > "${TMP}/bin/kubectl" <<'PY'
#!/usr/bin/env python3
import json
import os
import pathlib
import sys

args = sys.argv[1:]
fixture = pathlib.Path(os.environ["FIXTURE_DIR"])
operations = pathlib.Path(os.environ["OPERATIONS"])

def record(kind, **details):
    with operations.open("a", encoding="utf-8") as destination:
        destination.write(json.dumps({"kind": kind, **details}) + "\n")

if args[:2] == ["get", "configmap"] and "-A" in args:
    print((fixture / "configmaps.json").read_text(encoding="utf-8"))
elif args[:2] == ["get", "deployment"] and "-A" in args:
    print((fixture / "deployments.json").read_text(encoding="utf-8"))
elif args[:2] in (["get", "deploy"], ["get", "secret"]):
    raise SystemExit(1)
elif args[:3] == ["create", "-f", "-"]:
    manifest = json.load(sys.stdin)
    record("create", namespace=manifest["metadata"]["namespace"],
           name=manifest["metadata"]["name"], manifest=manifest)
elif len(args) >= 5 and args[0] == "-n" and args[2:4] == ["patch", "configmap"]:
    patch_file = pathlib.Path(args[args.index("--patch-file") + 1])
    record("patch", namespace=args[1], name=args[4],
           patch=json.loads(patch_file.read_text(encoding="utf-8")))
elif len(args) >= 4 and args[0] == "-n" and args[2] == "rollout":
    record("rollout", namespace=args[1], arguments=args[3:])
elif len(args) >= 4 and args[0] == "-n" and args[2] == "exec":
    record("exec", namespace=args[1], arguments=args[3:])
else:
    print(f"unexpected kubectl invocation: {args}", file=sys.stderr)
    raise SystemExit(2)
PY
chmod +x "${TMP}/bin/kubectl"

OUTPUT="$(PATH="${TMP}/bin:${PATH}" bash "${REPO}/scripts/single-vps-deploy/09-portal-header.sh")"
printf '%s\n' "${OUTPUT}"

python3 - "${OPERATIONS}" <<'PY'
import json
import pathlib
import sys

operations = [json.loads(line) for line in pathlib.Path(sys.argv[1]).read_text().splitlines()]
created = {(item["namespace"], item["name"]): item for item in operations if item["kind"] == "create"}
expected_created = {
    ("mb-grist", "opensuite-header-js"),
    ("mb-nextcloud", "opensuite-header-js"),
}
assert set(created) == expected_created, created
for item in created.values():
    labels = item["manifest"]["metadata"]["labels"]
    assert labels["opensuite.online/shared-header"] == "true"
    assert labels["app.kubernetes.io/component"] == "opensuite-header"
    assert labels["app.kubernetes.io/part-of"] == "open-suite"

patched = {(item["namespace"], item["name"]): item for item in operations if item["kind"] == "patch"}
expected_patched = expected_created | {
    ("mb-docs", "opensuite-header-js"),
    ("mb-element", "element-web-bureaublad-button"),
    ("mb-existing", "historical-shared-header"),
}
assert set(patched) == expected_patched, patched
assert ("mb-ignored", "unrelated-missing") not in patched
assert ("mb-ignored", "unmounted-legacy") not in patched
for key, item in patched.items():
    data = item["patch"]["data"]
    expected_key = "bureaublad-button.js" if key[0] == "mb-element" else "opensuite-header.js"
    assert list(data) == [expected_key]
    assert "Open Suite portal header" in data[expected_key]
    assert '{ label: "Chat", sub: "element", path: "/#/home" }' in data[expected_key]
    assert 'var HEADER_VERSION = "source";' not in data[expected_key]

execs = [item for item in operations if item["kind"] == "exec"]
assert len(execs) == 3, execs
assert {item["namespace"] for item in execs} == {"mb-nextcloud", "mb-grist", "mb-docs"}

restarts = [item for item in operations if item["kind"] == "rollout" and item["arguments"][0] == "restart"]
assert len(restarts) == 1 and restarts[0]["namespace"] == "mb-element", restarts
PY

grep -Fq 'Verified 3 live sidecar mounts at the published version' <<<"${OUTPUT}"
echo "fresh shared-header ConfigMap discovery and publication verified"
