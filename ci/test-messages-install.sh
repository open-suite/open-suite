#!/usr/bin/env bash
# Static contract test for the Messages first-install chart additions. Run after
# applying patches/local to the pinned mijn-bureau-infra checkout.
set -euo pipefail

INFRA="${1:?Usage: $0 <patched-infra-dir>}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
POSTGRES_VALUES="${INFRA}/helmfile/apps/messages/values-postgresql.yaml.gotmpl"
MIGRATE_JOB="${INFRA}/helmfile/apps/messages/charts/messages/templates/migrate-job.yaml"
DEMO_VALUES="${REPO}/helmfile/demo-values.yaml.tmpl"

require_literal() {
  local file="$1" expected="$2"
  if ! grep -Fq -- "${expected}" "${file}"; then
    echo "ERROR: $(basename "${file}") is missing: ${expected}" >&2
    exit 1
  fi
}

# PostgreSQL must not be BestEffort, and liveness must remain disabled for the
# full measured first-initialization window.
require_literal "${POSTGRES_VALUES}" 'resources: {{ .Values.resource.messages.postgresql | default dict | toYaml | nindent 4 }}'
STARTUP_PROBE="$(sed -n '/^  startupProbe:/,/^    successThreshold:/p' "${POSTGRES_VALUES}")"
grep -Fq 'enabled: true' <<<"${STARTUP_PROBE}"
grep -Fq 'failureThreshold: 60' <<<"${STARTUP_PROBE}"
RESOURCE_VALUES="$(sed -n '/^resource:/,/^autoscaling:/p' "${DEMO_VALUES}")"
grep -Fq '  messages:' <<<"${RESOURCE_VALUES}"
grep -Fq 'postgresql: { requests: { cpu: 100m, memory: 128Mi } }' <<<"${RESOURCE_VALUES}"

# Helm release ordering alone is insufficient. The migration must see a stable
# database, have bounded runtime, and retain Kubernetes Job retries.
require_literal "${MIGRATE_JOB}" 'backoffLimit: 3'
require_literal "${MIGRATE_JOB}" 'activeDeadlineSeconds: 1200'
require_literal "${MIGRATE_JOB}" 'name: wait-for-postgresql'
require_literal "${MIGRATE_JOB}" 'deadline = time.monotonic() + 600'
require_literal "${MIGRATE_JOB}" 'if stable >= 6:'
require_literal "${MIGRATE_JOB}" 'command: ["python", "manage.py", "migrate", "--no-input"]'

echo "Messages PostgreSQL startup and migration contracts verified"

if [ -n "${FRESH_INSTALL_ARTIFACT_DIR:-}" ]; then
  bash "${REPO}/ci/messages-install-benchmark.sh" \
    "${FRESH_INSTALL_ARTIFACT_DIR}/messages-benchmark" \
    "${FRESH_INSTALL_DOMAIN:-127.0.0.1.sslip.io}"
fi
