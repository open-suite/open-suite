#!/usr/bin/env bash
# Static guard for the measured Nextcloud PHP CronJob memory-cgroup OOM fix.
# Run against the pinned infra checkout after applying patches/local.
set -euo pipefail

INFRA="${1:?Usage: $0 <patched-infra-dir>}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VALUES="${INFRA}/helmfile/apps/nextcloud/values.yaml.gotmpl"
DEMO_VALUES="${REPO}/helmfile/demo-values.yaml.tmpl"

grep -Fq 'resources: {{ .Values.resource.nextcloud.cronjob | default dict | toYaml | nindent 4 }}' "${VALUES}"
grep -Fq 'cronjob: { requests: { cpu: 100m, memory: 64Mi }, limits: { cpu: 200m, memory: 256Mi } }' "${DEMO_VALUES}"

# Keep the correction scoped to the background PHP container. The interactive
# workload remains request-only and CPU limits are not introduced there.
grep -Fq 'nextcloud: { requests: { cpu: 150m, memory: 384Mi } }' "${DEMO_VALUES}"

echo "Nextcloud CronJob resource contracts verified"
