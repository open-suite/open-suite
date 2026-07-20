#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
infra_dir="${GRIST_INFRA_DIR:-}"

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

worktree="$(mktemp -d)"
cleanup() {
  git -C "${infra_dir}" worktree remove --force "${worktree}" >/dev/null 2>&1 || true
  rm -rf "${worktree}"
}
trap cleanup EXIT
git -C "${infra_dir}" worktree add --detach "${worktree}" "${expected_ref}" >/dev/null

for patch in "${repo_root}"/patches/local/grist-*.patch; do
  [[ -e "${patch}" ]] || {
    echo "No Grist patches found" >&2
    exit 1
  }
  git -C "${worktree}" apply --check "${patch}"
  git -C "${worktree}" apply "${patch}"
done

values="${worktree}/helmfile/apps/grist/values.yaml.gotmpl"
chart_values="${worktree}/helmfile/apps/grist/charts/grist/values.yaml"
deployment="${worktree}/helmfile/apps/grist/charts/grist/templates/deployment.yaml"
database_values="${worktree}/helmfile/environments/default/database.yaml.gotmpl"
objectstore_values="${worktree}/helmfile/environments/default/objectstore.yaml.gotmpl"

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
  /^customReadinessProbe:$/ { in_probe=1 }
  in_probe && /path: \/status\?ready=1/ { path=1 }
  in_probe && /port: 8484/ { port=1 }
  in_probe && /scheme: HTTP/ { scheme=1 }
  in_probe && /periodSeconds: 1/ { period=1 }
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

if grep -Eq 'GRIST_SANDBOX_FLAVOR.*unsandboxed|GRIST_PYODIDE_SKIP_DENO|SKIP_MIGRATIONS|synchronous[=:](OFF|0)|journal_mode[=:](OFF|MEMORY)' "${values}"; then
  echo "Unsafe Grist sandbox, migration, or SQLite durability override found" >&2
  exit 1
fi

echo "Grist regression guards passed at ${expected_ref}"
