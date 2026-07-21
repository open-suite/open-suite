#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
infra_dir="${GRIST_INFRA_DIR:-}"
helmfile_bin="${HELMFILE_BIN:-helmfile}"
helm_bin="${HELM_BIN:-helm}"

if [[ -z "${infra_dir}" || ! -d "${infra_dir}/.git" ]]; then
  echo "GRIST_INFRA_DIR must be a clone of MinBZK/mijn-bureau-infra" >&2
  exit 2
fi

expected_ref="$(<"${repo_root}/UPSTREAM_REF")"
actual_ref="$(git -C "${infra_dir}" rev-parse HEAD)"
if [[ "${actual_ref}" != "${expected_ref}" ]]; then
  echo "Grist guard requires pinned infra ${expected_ref}; got ${actual_ref}" >&2
  exit 1
fi
if [[ -n "$(git -C "${infra_dir}" status --porcelain)" ]]; then
  echo "Grist guard requires a clean infra checkout" >&2
  exit 1
fi
for command in envsubst "${helm_bin}" "${helmfile_bin}"; do
  if ! command -v "${command}" >/dev/null; then
    echo "Grist rendered guard requires ${command}" >&2
    exit 2
  fi
done

worktree="$(mktemp -d)"
cleanup() {
  git -C "${infra_dir}" worktree remove --force "${worktree}" >/dev/null 2>&1 || true
  rm -rf "${worktree}"
}
trap cleanup EXIT
git -C "${infra_dir}" worktree add --detach "${worktree}" "${expected_ref}" >/dev/null

for patch in "${repo_root}"/patches/local/*.patch; do
  git -C "${worktree}" apply --3way --check "${patch}" >/dev/null 2>&1
done
for patch in "${repo_root}"/patches/local/*.patch; do
  git -C "${worktree}" apply --3way "${patch}" >/dev/null 2>&1
done

values="${worktree}/helmfile/apps/grist/values.yaml.gotmpl"
chart_values="${worktree}/helmfile/apps/grist/charts/grist/values.yaml"
deployment="${worktree}/helmfile/apps/grist/charts/grist/templates/deployment.yaml"
database_values="${worktree}/helmfile/environments/default/database.yaml.gotmpl"
objectstore_values="${worktree}/helmfile/environments/default/objectstore.yaml.gotmpl"
rendered="${worktree}/grist-rendered.yaml"

require_count() {
  local expected="$1" pattern="$2" file="$3"
  local actual
  actual="$(grep -Ec -- "${pattern}" "${file}" || true)"
  if [[ "${actual}" != "${expected}" ]]; then
    echo "Expected ${expected} match(es) for ${pattern} in ${file}; got ${actual}" >&2
    exit 1
  fi
}

# Optimization is exact and cannot silently flip back to Grist's Linux default.
require_count 1 'name: GRIST_RESTART_SHELL' "${values}"
if ! awk '
  /name: GRIST_RESTART_SHELL/ { getline; if ($0 == "    value: \"false\"") ok++ }
  END { exit ok == 1 ? 0 : 1 }
' "${values}"; then
  echo "GRIST_RESTART_SHELL is not paired with value false" >&2
  exit 1
fi
if ! awk '
  /^customStartupProbe:$/ { in_probe=1 }
  in_probe && $0 == "    path: /status?ready=1" { path=1 }
  in_probe && $0 == "    port: 8484" { port=1 }
  in_probe && $0 == "    scheme: HTTP" { scheme=1 }
  in_probe && $0 == "  initialDelaySeconds: 5" { delay=1 }
  in_probe && $0 == "  periodSeconds: 1" { period=1 }
  in_probe && $0 == "  timeoutSeconds: 1" { timeout=1 }
  in_probe && $0 == "  failureThreshold: 45" { threshold=1 }
  in_probe && $0 == "  successThreshold: 1" { success=1 }
  in_probe && /^extraEnvVars:$/ { in_probe=0 }
  END { exit path && port && scheme && delay && period && timeout && threshold && success ? 0 : 1 }
' "${values}"; then
  echo "Grist startup probe no longer bounds initialization at 50 seconds" >&2
  exit 1
fi
if ! awk '
  /^customReadinessProbe:$/ { in_probe=1 }
  in_probe && $0 == "    path: /status?ready=1" { path=1 }
  in_probe && $0 == "    port: 8484" { port=1 }
  in_probe && $0 == "    scheme: HTTP" { scheme=1 }
  in_probe && $0 == "  periodSeconds: 1" { period=1 }
  in_probe && /^extraEnvVars:$/ { in_probe=0 }
  END { exit path && port && scheme && period ? 0 : 1 }
' "${values}"; then
  echo "Grist readiness must poll HTTP /status?ready=1 on port 8484 every second" >&2
  exit 1
fi

# Fail closed if durability, migrations' PostgreSQL source, OIDC, or sandboxing drifts.
require_count 1 'sandboxFlavor: .*default "gvisor"' "${values}"
require_count 1 '^  type:.*database\.grist\.type' "${values}"
require_count 1 '^auth:$' "${values}"
if [[ "$(awk '/^auth:$/ { getline; print; exit }' "${values}")" != "  enabled: true" ]]; then
  echo "Grist OIDC auth is not explicitly enabled" >&2
  exit 1
fi
if [[ "$(awk '/^persistence:$/ { getline; print; exit }' "${values}")" != "  enabled: false" ]]; then
  echo "Grist document storage topology changed; re-audit MinIO durability" >&2
  exit 1
fi
if [[ "$(awk '/^  grist:$/ { getline; print; exit }' "${database_values}")" != "    type: postgresql" ]]; then
  echo "Grist home database is no longer PostgreSQL" >&2
  exit 1
fi
if ! awk '
  /^  grist:$/ { in_grist=1; next }
  in_grist && /^  [[:alnum:]_-]+:$/ { in_grist=0 }
  in_grist && $0 == "    bucket: \"grist\"" { bucket=1 }
  in_grist && $0 == "    endpoint: \"grist-minio\"" { endpoint=1 }
  in_grist && $0 == "    isInternal: true" { internal=1 }
  END { exit bucket && endpoint && internal ? 0 : 1 }
' "${objectstore_values}"; then
  echo "Grist durable MinIO wiring changed" >&2
  exit 1
fi
require_count 1 'name: GRIST_SANDBOX_FLAVOR' "${deployment}"
require_count 1 'name: GRIST_OIDC_IDP_ISSUER' "${deployment}"
require_count 1 'name: GRIST_OIDC_IDP_CLIENT_ID' "${deployment}"
require_count 1 'name: GRIST_OIDC_IDP_CLIENT_SECRET' "${deployment}"
require_count 1 'name: GRIST_OIDC_SP_HOST' "${deployment}"
require_count 1 'name: GRIST_DOCS_MINIO_ENDPOINT' "${deployment}"
require_count 1 'name: GRIST_DOCS_MINIO_BUCKET' "${deployment}"
require_count 3 'path: /status' "${deployment}"
require_count 1 '^livenessProbe:$' "${chart_values}"
require_count 1 '^readinessProbe:$' "${chart_values}"
require_count 1 '^  digest: "sha256:0263064906e2fa88063129d1b84a6ae3d33acb090062e510b32f87b7a1c84917"$' "${chart_values}"

if grep -Eq 'GRIST_SANDBOX_FLAVOR.*unsandboxed|GRIST_PYODIDE_SKIP_DENO|SKIP_MIGRATIONS|synchronous[=:](OFF|0)|journal_mode[=:](OFF|MEMORY)' "${values}"; then
  echo "Unsafe Grist sandbox, migration, or SQLite durability override found" >&2
  exit 1
fi

mkdir -p "${worktree}/helmfile/environments/demo"
DOMAIN=example.test \
TLS_SELF_SIGNED=true \
INGRESS_ANNOTATIONS='' \
NEXTCLOUD_TAG=34.0.0-apache \
PORTAL_SHA=34512e5 \
MEET_TAG=v1.20.0 \
ELEMENT_TAG=sha-a11ee66 \
KC_BACKCHANNEL=http://keycloak-keycloak.mb-keycloak \
  envsubst '${DOMAIN} ${TLS_SELF_SIGNED} ${INGRESS_ANNOTATIONS} ${NEXTCLOUD_TAG} ${PORTAL_SHA} ${MEET_TAG} ${ELEMENT_TAG} ${KC_BACKCHANNEL}' \
  < "${repo_root}/helmfile/demo-values.yaml.tmpl" \
  > "${worktree}/helmfile/environments/demo/mijnbureau.yaml.gotmpl"

helm_path="$(dirname "$(command -v "${helm_bin}")")"
helmfile_path="$(dirname "$(command -v "${helmfile_bin}")")"
(
  cd "${worktree}"
  MIJNBUREAU_MASTER_PASSWORD=grist-render-guard-only \
    PATH="${helm_path}:${helmfile_path}:${PATH}" \
    "${helmfile_bin}" -e demo -l name=grist template > "${rendered}"
)

RENDERED_GRIST_DEPLOYMENT="${rendered}" python3 - <<'PY'
import os
import re
from pathlib import Path

documents = Path(os.environ["RENDERED_GRIST_DEPLOYMENT"]).read_text().split("\n---\n")
deployments = [
    document for document in documents
    if "\nkind: Deployment\n" in f"\n{document}\n"
    and re.search(r"\n  name: grist\n", f"\n{document}\n")
]
if len(deployments) != 1:
    raise SystemExit(f"expected one rendered Grist Deployment; got {len(deployments)}")
deployment = deployments[0]

image = "registry-1.docker.io/gristlabs/grist@sha256:0263064906e2fa88063129d1b84a6ae3d33acb090062e510b32f87b7a1c84917"
grist_images = re.findall(r"^\s+image: (\S*gristlabs/grist\S*)$", deployment, re.MULTILINE)
if grist_images != [image]:
    raise SystemExit("rendered Grist Deployment does not use the v1.7.15 index digest")
if deployment.count("- name: GRIST_RESTART_SHELL\n              value: \"false\"") != 1:
    raise SystemExit("rendered Grist Deployment does not disable RestartShell exactly once")

def probe(name):
    match = re.search(
        rf"\n          {name}:\n(?P<body>.*?)(?=\n          [A-Za-z])",
        deployment,
        re.DOTALL,
    )
    if not match:
        raise SystemExit(f"rendered Grist Deployment has no {name}")
    return match.group("body")

liveness = probe("livenessProbe")
readiness = probe("readinessProbe")
startup = probe("startupProbe")

def require_scalar(body, key, expected, probe_name):
    values = re.findall(
        rf"^\s+{re.escape(key)}:\s*(\S+)\s*$",
        body,
        re.MULTILINE,
    )
    if values != [expected]:
        raise SystemExit(
            f"rendered {probe_name} {key} must be exactly {expected}; got {values}"
        )

require_scalar(liveness, "path", "/status", "livenessProbe")
require_scalar(readiness, "path", "/status?ready=1", "readinessProbe")
require_scalar(readiness, "periodSeconds", "1", "readinessProbe")
for key, expected in {
    "path": "/status?ready=1",
    "port": "8484",
    "scheme": "HTTP",
    "initialDelaySeconds": "5",
    "periodSeconds": "1",
    "timeoutSeconds": "1",
    "failureThreshold": "45",
    "successThreshold": "1",
}.items():
    require_scalar(startup, key, expected, "startupProbe")
PY

echo "Grist regression guards passed at ${expected_ref}"
