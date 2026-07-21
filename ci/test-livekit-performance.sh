#!/usr/bin/env bash
# Static contract test for the narrowly scoped LiveKit startup optimization.
# Run after applying patches/local to the pinned mijn-bureau-infra checkout.
set -euo pipefail

INFRA="${1:?Usage: $0 <patched-infra-dir>}"
LIVEKIT_VALUES="${INFRA}/helmfile/apps/livekit/values.yaml.gotmpl"
REDIS_VALUES="${INFRA}/helmfile/apps/livekit/values-redis.yaml.gotmpl"
DEPLOYMENT="${INFRA}/helmfile/apps/livekit/charts/livekit-server/templates/deployment.yaml"
CHART_VALUES="${INFRA}/helmfile/apps/livekit/charts/livekit-server/values.yaml"
HELMFILE="${INFRA}/helmfile/apps/livekit/helmfile-child.yaml.gotmpl"

extract_block() {
  local file="$1" start="$2" end="$3"
  sed -n "/${start}/,/${end}/p" "${file}"
}

# Redis readiness runs promptly but retains its authenticated health check.
# LiveKit must keep the chart's 10-second default until node_ip is declarative:
# its `/` check does not reject the initial 1.3.5.7 placeholder.
if grep -q '^  readinessProbe:' "${LIVEKIT_VALUES}"; then
  echo "ERROR: LiveKit readiness override bypasses the node_ip cutover buffer" >&2
  exit 1
fi
REDIS_MASTER="$(extract_block "${REDIS_VALUES}" '^master:' '^replica:')"
REDIS_LIVENESS="$(sed -n '/^  livenessProbe:/,/^  readinessProbe:/p' <<<"${REDIS_MASTER}")"
REDIS_PROBE="$(sed -n '/^  readinessProbe:/,/^  customStartupProbe:/p' <<<"${REDIS_MASTER}")"
grep -Fq 'enabled: true' <<<"${REDIS_LIVENESS}"
grep -Fq 'enabled: true' <<<"${REDIS_PROBE}"
grep -Fq 'initialDelaySeconds: 1' <<<"${REDIS_PROBE}"
grep -Fq 'timeoutSeconds: 1' <<<"${REDIS_PROBE}"
LIVEKIT_READINESS_TEMPLATE="$(sed -n '/else if .Values.livekit.readinessProbe.enabled/,/else if .Values.livekit.startupProbe.enabled/p' "${DEPLOYMENT}")"
grep -Fq 'readinessProbe:' <<<"${LIVEKIT_READINESS_TEMPLATE}"
grep -Fq 'httpGet:' <<<"${LIVEKIT_READINESS_TEMPLATE}"
grep -Fq 'path: /' <<<"${LIVEKIT_READINESS_TEMPLATE}"
CHART_LIVENESS="$(sed -n '/^  livenessProbe:/,/^  readinessProbe:/p' "${CHART_VALUES}")"
CHART_READINESS="$(sed -n '/^  readinessProbe:/,/^  startupProbe:/p' "${CHART_VALUES}")"
grep -Fq 'enabled: true' <<<"${CHART_LIVENESS}"
grep -Fq 'enabled: true' <<<"${CHART_READINESS}"
grep -Fq 'initialDelaySeconds: 10' <<<"${CHART_READINESS}"

# Guard the constraints this performance change must not weaken.
REDIS_AUTH="$(extract_block "${REDIS_VALUES}" '^auth:' '^commonConfiguration:')"
grep -Fq 'enabled: true' <<<"${REDIS_AUTH}"
REDIS_POLICY="$(extract_block "${REDIS_VALUES}" '^networkPolicy:' '^podSecurityPolicy:')"
grep -Fq 'enabled: true' <<<"${REDIS_POLICY}"
grep -Fq 'allowExternal: false' <<<"${REDIS_POLICY}"
grep -Fq 'app.kubernetes.io/name: livekit-server' <<<"${REDIS_POLICY}"
LIVEKIT_POLICY="$(sed -n '/^networkPolicy:/,$p' "${LIVEKIT_VALUES}")"
grep -Fq 'enabled: true' <<<"${LIVEKIT_POLICY}"
grep -Fq 'resources: {{ .Values.resource.livekit.livekit | default dict | toYaml | nindent 4 }}' "${LIVEKIT_VALUES}"
grep -Fq 'resources: {{ .Values.resource.livekit.redis | default dict | toYaml | nindent 4 }}' <<<"${REDIS_MASTER}"
grep -Fq 'needs:' "${HELMFILE}"
grep -Fq 'livekit-redis' "${HELMFILE}"
grep -Fq 'use_external_ip: false' "${CHART_VALUES}"
grep -Fq 'value: "{{ .Values.livekit.loadBalancerIP}}"' "${DEPLOYMENT}"
grep -Fq 'kubectl set env deployment/livekit-server NODE_IP=$ip' "${CHART_VALUES}"
grep -Fq -- '--key-file=/etc/livekit/keyfile.txt' "${CHART_VALUES}"
LIVEKIT_CONFIG="$(extract_block "${LIVEKIT_VALUES}" '^  config:' '^  redis:')"
grep -Fq 'turn:' <<<"${LIVEKIT_CONFIG}"
grep -Fq 'enabled: false' <<<"${LIVEKIT_CONFIG}"

echo "LiveKit startup static performance and safety contracts verified"
