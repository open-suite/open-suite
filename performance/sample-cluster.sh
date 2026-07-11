#!/usr/bin/env bash
set -euo pipefail

KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
DURATION="${SAMPLE_DURATION:-120}"
INTERVAL="${SAMPLE_INTERVAL:-2}"
OUTPUT="${SAMPLE_OUTPUT:-cluster-samples.csv}"
export KUBECONFIG

namespaces='^(mb-keycloak|mb-bureaublad|mb-nextcloud|mb-element|mb-collabora|mb-docs|mb-meet|mb-grist|mb-livekit)'
deadline=$((SECONDS + DURATION))

printf 'captured_at,namespace,pod,container,cpu,memory\n' > "${OUTPUT}"
while (( SECONDS < deadline )); do
  captured_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  kubectl top pod -A --containers --no-headers 2>/dev/null \
    | awk -v captured_at="${captured_at}" -v pattern="${namespaces}" \
      '$1 ~ pattern { printf "%s,%s,%s,%s,%s,%s\n", captured_at, $1, $2, $3, $4, $5 }' \
    >> "${OUTPUT}"
  sleep "${INTERVAL}"
done

echo "Wrote ${OUTPUT}"
