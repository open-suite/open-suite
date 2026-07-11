#!/usr/bin/env bash
set -euo pipefail

KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
export KUBECONFIG

namespaces='^(mb-nextcloud|mb-element|mb-collabora|mb-docs|mb-meet|mb-grist|mb-livekit)'

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
