#!/usr/bin/env bash
set -euo pipefail

KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
DURATION="${SAMPLE_DURATION:-120}"
INTERVAL="${SAMPLE_INTERVAL:-2}"
OUTPUT="${SAMPLE_OUTPUT:-cluster-samples.csv}"
METADATA_OUTPUT="${SAMPLE_METADATA_OUTPUT:-${OUTPUT%.csv}-metadata.txt}"
export KUBECONFIG

case "${DURATION}" in
  ''|*[!0-9]*|0) echo "SAMPLE_DURATION must be a positive integer" >&2; exit 2 ;;
esac
case "${INTERVAL}" in
  ''|*[!0-9]*|0) echo "SAMPLE_INTERVAL must be a positive integer" >&2; exit 2 ;;
esac

namespaces='^(mb-keycloak|mb-bureaublad|mb-nextcloud|mb-element|mb-collabora|mb-docs|mb-meet|mb-grist|mb-livekit|mb-messages)$'
deadline=$((SECONDS + DURATION))
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
polls=0
failed_polls=0

printf 'captured_at,namespace,pod,container,cpu,memory\n' > "${OUTPUT}"
while (( SECONDS < deadline )); do
  captured_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if sample="$(kubectl top pod -A --containers --no-headers 2>/dev/null)"; then
    polls=$((polls + 1))
    awk -v captured_at="${captured_at}" -v pattern="${namespaces}" \
      '$1 ~ pattern { printf "%s,%s,%s,%s,%s,%s\n", captured_at, $1, $2, $3, $4, $5 }' \
      <<< "${sample}" >> "${OUTPUT}"
  else
    failed_polls=$((failed_polls + 1))
  fi
  sleep "${INTERVAL}"
done

echo "Wrote ${OUTPUT}"
{
  echo "started_at=${started_at}"
  echo "finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "baseline=${BENCHMARK_BASELINE:-unspecified}"
  echo "workload=${BENCHMARK_WORKLOAD:-unspecified}"
  echo "environment=${BENCHMARK_ENVIRONMENT:-unspecified}"
  echo "deployment_revision=${BENCHMARK_DEPLOYMENT_REVISION:-unspecified}"
  echo "requested_duration_seconds=${DURATION}"
  echo "interval_seconds=${INTERVAL}"
  echo "successful_polls=${polls}"
  echo "failed_polls=${failed_polls}"
  echo "container_observations=$(($(wc -l < "${OUTPUT}") - 1))"
} | tee "${METADATA_OUTPUT}"
echo "Wrote ${METADATA_OUTPUT}"
