#!/usr/bin/env bash
set -euo pipefail

KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
export KUBECONFIG

namespaces='^(mb-keycloak|mb-bureaublad|mb-nextcloud|mb-element|mb-collabora|mb-docs|mb-meet|mb-grist|mb-livekit|mb-messages)$'

echo "# Benchmark support metadata"
echo "captured_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "baseline=${BENCHMARK_BASELINE:-unspecified}"
echo "workload=${BENCHMARK_WORKLOAD:-cluster-state-snapshot}"
echo "environment=${BENCHMARK_ENVIRONMENT:-unspecified}"
echo "deployment_revision=${BENCHMARK_DEPLOYMENT_REVISION:-unspecified}"

echo
echo "# Node"
kubectl top node

echo
echo "# Workload resources"
kubectl get deployment,statefulset -A \
  -o custom-columns='NAMESPACE:.metadata.namespace,KIND:.kind,NAME:.metadata.name,READY:.status.readyReplicas,REQUEST_CPU:.spec.template.spec.containers[*].resources.requests.cpu,REQUEST_MEMORY:.spec.template.spec.containers[*].resources.requests.memory,LIMIT_CPU:.spec.template.spec.containers[*].resources.limits.cpu,LIMIT_MEMORY:.spec.template.spec.containers[*].resources.limits.memory' \
  | awk -v pattern="${namespaces}" 'NR == 1 || $1 ~ pattern'

echo
echo "# Pod usage"
kubectl top pod -A --containers \
  | awk -v pattern="${namespaces}" 'NR == 1 || $1 ~ pattern'
