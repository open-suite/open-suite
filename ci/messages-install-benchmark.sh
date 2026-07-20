#!/usr/bin/env bash
# Collect first-install Messages timings from Kubernetes transition timestamps,
# then measure the first authenticated Mail page and Matrix sync in a clean
# browser. The normal deploy and all of its probes remain unchanged.
set -Eeuo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ARTIFACT_DIR="${1:?Usage: $0 <artifact-dir> [domain]}"
DOMAIN="${2:-127.0.0.1.sslip.io}"
CSV="${ARTIFACT_DIR}/milestones.csv"
FIRST_USE="${ARTIFACT_DIR}/first-use.json"
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"

install -d -m 0755 "${ARTIFACT_DIR}"
kubectl -n mb-messages wait --for=condition=Ready pod/messages-cluster-rw-0 \
  --timeout=1200s
kubectl -n mb-messages wait --for=condition=Ready pod/messages-opensearch-0 \
  --timeout=1200s
kubectl -n mb-messages wait --for=condition=Ready pod \
  -l app.kubernetes.io/name=messages,app.kubernetes.io/component=backend \
  --timeout=1200s
kubectl -n mb-messages wait --for=condition=Ready pod \
  -l app.kubernetes.io/name=messages,app.kubernetes.io/component=frontend \
  --timeout=1200s
kubectl -n mb-messages wait --for=condition=Complete job \
  -l app.kubernetes.io/name=messages,app.kubernetes.io/component=migrate \
  --timeout=1200s

kubectl -n mb-messages get pods -o json > "${ARTIFACT_DIR}/pods.json"
kubectl -n mb-messages get jobs -o json > "${ARTIFACT_DIR}/jobs.json"
kubectl -n mb-messages get events --sort-by=.lastTimestamp \
  > "${ARTIFACT_DIR}/events.txt"

FRONTEND_IP="$(kubectl -n mb-messages get service messages-frontend \
  -o jsonpath='{.spec.clusterIP}')"
FRONTEND_PORT="$(kubectl -n mb-messages get service messages-frontend \
  -o jsonpath='{.spec.ports[?(@.name=="http")].port}')"
FRONTEND_URL="http://${FRONTEND_IP}:${FRONTEND_PORT}"
curl --fail --silent --show-error --max-time 15 "${FRONTEND_URL}/" >/dev/null
PAGE_OBSERVED_AT="$(date --utc '+%Y-%m-%dT%H:%M:%S.%3NZ')"
curl --fail --silent --show-error --max-time 15 \
  "${FRONTEND_URL}/api/v1.0/config/" >/dev/null
CONFIG_OBSERVED_AT="$(date --utc '+%Y-%m-%dT%H:%M:%S.%3NZ')"

python3 - "${ARTIFACT_DIR}/pods.json" "${ARTIFACT_DIR}/jobs.json" \
  "${CSV}" "${PAGE_OBSERVED_AT}" "${CONFIG_OBSERVED_AT}" <<'PY'
import csv
import datetime as dt
import json
import pathlib
import sys

pods_path, jobs_path, output_path = map(pathlib.Path, sys.argv[1:4])
page_observed_at, config_observed_at = sys.argv[4:]
pods = json.loads(pods_path.read_text())["items"]
jobs = json.loads(jobs_path.read_text())["items"]


def parse(value):
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


def pod(component=None, name=None):
    candidates = []
    for item in pods:
        labels = item["metadata"].get("labels", {})
        if name and item["metadata"]["name"] != name:
            continue
        if component and labels.get("app.kubernetes.io/component") != component:
            continue
        candidates.append(item)
    if not candidates:
        raise RuntimeError(f"missing pod: component={component!r}, name={name!r}")
    return min(candidates, key=lambda item: item["metadata"]["creationTimestamp"])


def job(component):
    candidates = [
        item
        for item in jobs
        if item["metadata"].get("labels", {}).get("app.kubernetes.io/component") == component
    ]
    if not candidates:
        raise RuntimeError(f"missing job: component={component!r}")
    return min(candidates, key=lambda item: item["metadata"]["creationTimestamp"])


def status(item, container, init=False):
    key = "initContainerStatuses" if init else "containerStatuses"
    return next(value for value in item["status"][key] if value["name"] == container)


def started(container_status):
    timestamps = []
    for state in (container_status.get("state", {}), container_status.get("lastState", {})):
        value = state.get("running", {}).get("startedAt") or state.get("terminated", {}).get("startedAt")
        if value:
            timestamps.append(value)
    return min(timestamps, key=parse) if timestamps else None


def finished(container_status):
    return container_status.get("state", {}).get("terminated", {}).get("finishedAt")


def ready(item):
    return next(
        condition["lastTransitionTime"]
        for condition in item["status"].get("conditions", [])
        if condition["type"] == "Ready" and condition["status"] == "True"
    )


postgres = pod(name="messages-cluster-rw-0")
migration = pod(component="migrate")
migration_job = job("migrate")
backend = pod(component="backend")
frontend = pod(component="frontend")
opensearch = pod(name="messages-opensearch-0")
postgres_status = status(postgres, "postgresql")
stability_status = status(migration, "wait-for-postgresql", init=True)
migration_status = status(migration, "migrate")
backend_status = status(backend, "backend")
frontend_status = status(frontend, "frontend")
opensearch_status = status(opensearch, "opensearch")

milestones = [
    ("postgresql-pod-created", postgres["metadata"]["creationTimestamp"], "pod created"),
    ("postgresql-container-started", started(postgres_status), f"restarts={postgres_status['restartCount']}"),
    ("postgresql-ready", ready(postgres), "pod Ready"),
    ("migration-pod-created", migration["metadata"]["creationTimestamp"], "pod created"),
    ("migration-db-stability-started", started(stability_status), "durable 6x/30s gate"),
    ("migration-db-stability-passed", finished(stability_status), "durable 6x/30s gate"),
    ("migration-started", started(migration_status), "manage.py migrate --no-input"),
    ("migration-finished", finished(migration_status), "manage.py migrate --no-input"),
    (
        "migration-job-complete",
        next(
            condition["lastTransitionTime"]
            for condition in migration_job["status"]["conditions"]
            if condition["type"] == "Complete" and condition["status"] == "True"
        ),
        "durable Kubernetes Job completed",
    ),
    ("backend-pod-created", backend["metadata"]["creationTimestamp"], "pod created"),
    ("backend-container-started", started(backend_status), f"restarts={backend_status['restartCount']}"),
    ("backend-ready", ready(backend), "pod Ready"),
    ("frontend-pod-created", frontend["metadata"]["creationTimestamp"], "pod created"),
    ("frontend-container-started", started(frontend_status), f"restarts={frontend_status['restartCount']}"),
    ("frontend-ready", ready(frontend), "both containers Ready"),
    ("opensearch-pod-created", opensearch["metadata"]["creationTimestamp"], "pod created"),
    ("opensearch-container-started", started(opensearch_status), f"restarts={opensearch_status['restartCount']}"),
    ("opensearch-ready", ready(opensearch), "pod Ready"),
    ("first-page-observed", page_observed_at, "post-deploy 2xx upper bound"),
    ("first-config-observed", config_observed_at, "post-deploy 2xx upper bound"),
]
if any(timestamp is None for _, timestamp, _ in milestones):
    missing = [name for name, timestamp, _ in milestones if timestamp is None]
    raise RuntimeError(f"missing transition timestamp(s): {missing}")

origin = min(parse(timestamp) for _, timestamp, _ in milestones)
with output_path.open("w", newline="") as output:
    writer = csv.writer(output)
    writer.writerow(("milestone", "observed_at", "elapsed_seconds", "detail"))
    for name, timestamp, detail in sorted(milestones, key=lambda item: parse(item[1])):
        writer.writerow((name, timestamp, f"{(parse(timestamp) - origin).total_seconds():.3f}", detail))
PY

# Provision a run-scoped user after installation, outside the timed browser
# section. This does not alter production initialization or authentication.
kubectl -n mb-keycloak exec -i keycloak-keycloak-0 -c keycloak -- sh -s -- \
  messages-benchmark messages-benchmark@example.com \
  messagesBenchmarkPassword123 <<'SH'
set -eu
USERNAME="$1"
EMAIL="$2"
PASSWORD="$3"
KC=/opt/bitnami/keycloak/bin/kcadm.sh
CFG=/tmp/messages-benchmark-kc.config
ADMIN_PASSWORD="$(cat "$KC_BOOTSTRAP_ADMIN_PASSWORD_FILE")"
"$KC" config credentials --config "$CFG" --server http://localhost:8080/ \
  --realm master --user admin --password "$ADMIN_PASSWORD" >/dev/null
USER_ID="$("$KC" get users --config "$CFG" -r mijnbureau -q "username=${USERNAME}" \
  -q exact=true --fields id \
  | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
  | head -1)"
if [ -z "${USER_ID}" ]; then
  USER_ID="$("$KC" create users --config "$CFG" -r mijnbureau -i \
    -s "username=${USERNAME}" -s "email=${EMAIL}" -s emailVerified=true \
    -s enabled=true -s firstName=Messages -s lastName=Benchmark)"
fi
"$KC" set-password --config "$CFG" -r mijnbureau --userid "${USER_ID}" \
  --new-password "${PASSWORD}"
SH

# Browser installation happens after all infrastructure timestamps were
# captured, so it cannot influence the startup distribution.
npm install --no-save --no-package-lock playwright
npx playwright install --with-deps chromium
MESSAGES_BENCHMARK_DOMAIN="${DOMAIN}" \
MESSAGES_BENCHMARK_USER="messages-benchmark" \
MESSAGES_BENCHMARK_PASSWORD="messagesBenchmarkPassword123" \
node "${REPO}/ci/messages-first-use-benchmark.mjs" "${FIRST_USE}"

python3 "${REPO}/ci/messages-benchmark-report.py" \
  "${CSV}" "${FIRST_USE}" "${ARTIFACT_DIR}/report.md"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  cat "${ARTIFACT_DIR}/report.md" >> "${GITHUB_STEP_SUMMARY}"
fi
