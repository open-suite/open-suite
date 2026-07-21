#!/usr/bin/env bash
# Static contract test for the Messages first-install chart additions. Run after
# applying patches/local to the pinned mijn-bureau-infra checkout.
set -euo pipefail

INFRA="${1:?Usage: $0 <patched-infra-dir>}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
POSTGRES_VALUES="${INFRA}/helmfile/apps/messages/values-postgresql.yaml.gotmpl"
MIGRATE_JOB="${INFRA}/helmfile/apps/messages/charts/messages/templates/migrate-job.yaml"
OPENSEARCH_STATEFULSET="${INFRA}/helmfile/apps/messages/charts/messages/templates/opensearch-statefulset.yaml"
KEYCLOAK_EGRESS="${INFRA}/helmfile/apps/messages/charts/messages/templates/backend-keycloak-networkpolicy.yaml"
KEYCLOAK_REALM="${INFRA}/helmfile/apps/keycloak/keycloak.yaml.gotmpl"
MESSAGES_VALUES="${INFRA}/helmfile/apps/messages/values.yaml.gotmpl"
HEADER_SOURCE="${REPO}/overlays/portal-header/opensuite-header.js"
HEADER_PUBLISHER="${REPO}/scripts/single-vps-deploy/09-portal-header.sh"
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

# The namespace-wide egress whitelist must not break OIDC token exchange.
# Keep the exception scoped to the backend, Keycloak pods, and their HTTP port.
require_literal "${KEYCLOAK_EGRESS}" 'component" "backend"'
require_literal "${KEYCLOAK_EGRESS}" 'kubernetes.io/metadata.name: {{ .Values.backend.keycloakNamespace | quote }}'
require_literal "${KEYCLOAK_EGRESS}" 'app.kubernetes.io/name: keycloak'
require_literal "${KEYCLOAK_EGRESS}" 'app.kubernetes.io/component: keycloak'
require_literal "${KEYCLOAK_EGRESS}" 'port: 8080'

# With Mail deployed, every published shared header must start a top-level,
# stateful Messages RP logout. Without Mail, the existing auth-gate target
# remains. The publisher flips only the deployment-specific temporary copy.
require_literal "${HEADER_SOURCE}" 'logout.href = MAIL_ENABLED'
require_literal "${HEADER_SOURCE}" '? origin("messages") + "/api/v1.0/logout/"'
require_literal "${HEADER_SOURCE}" ': origin("auth") + "/logout?rd=" + encodeURIComponent(origin("bridge") + "/");'
require_literal "${HEADER_PUBLISHER}" "sed -i 's/var MAIL_ENABLED = false;/var MAIL_ENABLED = true;/'"

# django-lasuite must retain the Messages session while Keycloak returns a
# random state to this exact main-frame callback. Only after state validation
# may it clear the session and use the fixed operator-configured auth-gate hop.
require_literal "${MESSAGES_VALUES}" '{{- $portalUrl := printf "https://%s.%s/" .Values.global.hostname.bureaublad .Values.global.domain }}'
require_literal "${MESSAGES_VALUES}" '{{- $logoutRedirectUrl := printf "https://auth.%s/logout?rd=%s" .Values.global.domain (urlquery $portalUrl) }}'
require_literal "${MESSAGES_VALUES}" 'ALLOW_LOGOUT_GET_METHOD: "true"'
require_literal "${MESSAGES_VALUES}" 'OIDC_OP_LOGOUT_ENDPOINT: {{ .Values.authentication.oidc.end_session_endpoint | quote }}'
require_literal "${MESSAGES_VALUES}" 'LOGOUT_REDIRECT_URL: {{ $logoutRedirectUrl | quote }}'
MESSAGES_CLIENT="$(sed -n '/"clientId": "{{ .Values.authentication.client.messages.client_id }}"/,/"clientId": "{{ .Values.authentication.client.messagesRestApi.client_id }}"/p' "${KEYCLOAK_REALM}")"
grep -Fq '"frontchannelLogout": false' <<<"${MESSAGES_CLIENT}"
grep -Fq '"backchannel.logout.url": ""' <<<"${MESSAGES_CLIENT}"
grep -Fq '"frontchannel.logout.url": ""' <<<"${MESSAGES_CLIENT}"
grep -Fq '"post.logout.redirect.uris": "https://{{ .Values.global.hostname.messages }}.{{ .Values.global.domain }}/api/v1.0/logout-callback/"' <<<"${MESSAGES_CLIENT}"

# A startup probe prevents liveness from repeatedly restarting a healthy cold
# start. Readiness and liveness remain as strict as before startup succeeds.
OPENSEARCH_STARTUP_PROBE="$(sed -n '/^          startupProbe:/,/^            failureThreshold:/p' "${OPENSEARCH_STATEFULSET}")"
grep -Fq 'path: /_cluster/health' <<<"${OPENSEARCH_STARTUP_PROBE}"
grep -Fq 'periodSeconds: 10' <<<"${OPENSEARCH_STARTUP_PROBE}"
grep -Fq 'timeoutSeconds: 5' <<<"${OPENSEARCH_STARTUP_PROBE}"
grep -Fq 'failureThreshold: 60' <<<"${OPENSEARCH_STARTUP_PROBE}"
OPENSEARCH_READINESS_PROBE="$(sed -n '/^          readinessProbe:/,/^            periodSeconds:/p' "${OPENSEARCH_STATEFULSET}")"
grep -Fq 'path: /_cluster/health' <<<"${OPENSEARCH_READINESS_PROBE}"
grep -Fq 'initialDelaySeconds: 20' <<<"${OPENSEARCH_READINESS_PROBE}"
grep -Fq 'periodSeconds: 10' <<<"${OPENSEARCH_READINESS_PROBE}"
OPENSEARCH_LIVENESS_PROBE="$(sed -n '/^          livenessProbe:/,/^            periodSeconds:/p' "${OPENSEARCH_STATEFULSET}")"
grep -Fq 'tcpSocket:' <<<"${OPENSEARCH_LIVENESS_PROBE}"
grep -Fq 'initialDelaySeconds: 60' <<<"${OPENSEARCH_LIVENESS_PROBE}"
grep -Fq 'periodSeconds: 20' <<<"${OPENSEARCH_LIVENESS_PROBE}"

echo "Messages PostgreSQL, migration, logout, and OpenSearch probe contracts verified"

if [ -n "${FRESH_INSTALL_ARTIFACT_DIR:-}" ]; then
  bash "${REPO}/ci/messages-install-benchmark.sh" \
    "${FRESH_INSTALL_ARTIFACT_DIR}/messages-benchmark" \
    "${FRESH_INSTALL_DOMAIN:-127.0.0.1.sslip.io}"
fi
