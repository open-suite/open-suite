#!/usr/bin/env bash
# Fresh-install acceptance test for a standard GitHub-hosted Ubuntu runner.
# This intentionally deploys the normal, complete self-signed configuration;
# any future reduced CI profile must be justified by measurements from this
# path rather than assumptions based on the larger local Lima VM.
set -Eeuo pipefail

COMMAND="${1:-run}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="${FRESH_INSTALL_DOMAIN:-127.0.0.1.sslip.io}"
ARTIFACT_DIR="${FRESH_INSTALL_ARTIFACT_DIR:-/tmp/opensuite-fresh-install}"
METRICS="${ARTIFACT_DIR}/host-resources.csv"
PHASE_FILE="${ARTIFACT_DIR}/phase"
MASTER_PASSWORD="${FRESH_INSTALL_MASTER_PASSWORD:-freshInstallMasterPassword123}"
READY_TIMEOUT_SECONDS="${FRESH_INSTALL_READY_TIMEOUT_SECONDS:-1200}"
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
export OPEN_SUITE_TLS_MODE=selfsigned
export OPEN_SUITE_DEMO_MODE=false
export MIJNBUREAU_MASTER_PASSWORD="${MASTER_PASSWORD}"

EXPECTED_NAMESPACES=(
  mb-bureaublad
  mb-collabora
  mb-docs
  mb-element
  mb-grist
  mb-keycloak
  mb-livekit
  mb-meet
  mb-messages
  mb-nextcloud
)

MONITOR_PID=""

usage() {
  echo "Usage: sudo $0 {run|conformance|diagnostics}"
}

set_phase() {
  local phase="$1"
  printf '%s\n' "${phase}" > "${PHASE_FILE}"
  echo "==> phase: ${phase}"
}

record_host() {
  {
    echo "recorded_at=$(date --utc --iso-8601=seconds)"
    echo "domain=${DOMAIN}"
    echo "tls_mode=${OPEN_SUITE_TLS_MODE}"
    echo "ci_profile=none (complete deployment values)"
    echo "included_apps=bureaublad,collabora,docs,element,grist,keycloak,livekit,meet,messages,nextcloud"
    echo "deployment_exclusions=ollama,clamav,openproject (normal deployment defaults; not CI exclusions)"
    echo
    sed -n '1,12p' /etc/os-release
    echo
    uname -a
    echo
    lscpu | grep -E '^(Architecture|CPU\(s\)|Model name|Thread|Core|Socket)'
    echo
    free -b
    echo
    df -B1 /
  } > "${ARTIFACT_DIR}/host.txt"
}

monitor_resources() {
  local sample=0 phase mem_total mem_available swap_free disk_used disk_available
  local k3s_bytes=0 load1

  echo "timestamp,phase,mem_total_bytes,mem_available_bytes,swap_free_bytes,disk_used_bytes,disk_available_bytes,k3s_bytes,load1" > "${METRICS}"
  while true; do
    phase="$(cat "${PHASE_FILE}" 2>/dev/null || echo startup)"
    mem_total="$(awk '/^MemTotal:/ {print $2 * 1024}' /proc/meminfo)"
    mem_available="$(awk '/^MemAvailable:/ {print $2 * 1024}' /proc/meminfo)"
    swap_free="$(awk '/^SwapFree:/ {print $2 * 1024}' /proc/meminfo)"
    read -r disk_used disk_available < <(df -B1 --output=used,avail / | tail -1)
    load1="$(cut -d' ' -f1 /proc/loadavg)"
    if ((sample % 4 == 0)) && [ -d /var/lib/rancher/k3s ]; then
      k3s_bytes="$(du -sx -B1 /var/lib/rancher/k3s 2>/dev/null | awk '{print $1}' || true)"
      k3s_bytes="${k3s_bytes:-0}"
    fi
    printf '%s,%s,%.0f,%.0f,%.0f,%s,%s,%s,%s\n' \
      "$(date --utc --iso-8601=seconds)" "${phase}" \
      "${mem_total}" "${mem_available}" "${swap_free}" \
      "${disk_used}" "${disk_available}" "${k3s_bytes}" "${load1}" \
      >> "${METRICS}"
    sample=$((sample + 1))
    sleep 15
  done
}

start_monitor() {
  install -d -m 0755 "${ARTIFACT_DIR}"
  set_phase startup
  record_host
  monitor_resources &
  MONITOR_PID=$!
}

stop_monitor() {
  if [ -n "${MONITOR_PID}" ]; then
    kill "${MONITOR_PID}" 2>/dev/null || true
    wait "${MONITOR_PID}" 2>/dev/null || true
    MONITOR_PID=""
  fi
}

summarize_resources() {
  [ -s "${METRICS}" ] || return 0
  python3 - "${METRICS}" "${ARTIFACT_DIR}/resource-summary.md" <<'PY'
import csv
import pathlib
import sys

source, destination = map(pathlib.Path, sys.argv[1:])
rows = list(csv.DictReader(source.open()))
if not rows:
    raise SystemExit(0)

numeric = (
    "mem_total_bytes", "mem_available_bytes", "swap_free_bytes",
    "disk_used_bytes", "disk_available_bytes", "k3s_bytes",
)
for row in rows:
    for key in numeric:
        row[key] = int(float(row[key]))

gib = 1024 ** 3
initial_disk = rows[0]["disk_used_bytes"]

def measurements(selected):
    peak_memory = max(r["mem_total_bytes"] - r["mem_available_bytes"] for r in selected)
    minimum_available = min(r["mem_available_bytes"] for r in selected)
    peak_disk = max(r["disk_used_bytes"] for r in selected)
    minimum_disk_available = min(r["disk_available_bytes"] for r in selected)
    peak_k3s = max(r["k3s_bytes"] for r in selected)
    return peak_memory, minimum_available, peak_disk, minimum_disk_available, peak_k3s

ordered_phases = list(dict.fromkeys(r["phase"] for r in rows))
lines = [
    "# Fresh-install resource measurements",
    "",
    f"Samples: {len(rows)} at 15-second intervals ({rows[0]['timestamp']} through {rows[-1]['timestamp']}).",
    "",
    "| phase | peak used RAM | minimum available RAM | peak root disk growth | minimum root disk available | peak k3s storage |",
    "|---|---:|---:|---:|---:|---:|",
]
for phase in ordered_phases:
    selected = [row for row in rows if row["phase"] == phase]
    peak_memory, minimum_available, peak_disk, minimum_disk_available, peak_k3s = measurements(selected)
    lines.append(
        f"| {phase} | {peak_memory / gib:.2f} GiB | {minimum_available / gib:.2f} GiB | "
        f"{(peak_disk - initial_disk) / gib:.2f} GiB | {minimum_disk_available / gib:.2f} GiB | "
        f"{peak_k3s / gib:.2f} GiB |"
    )

peak_memory, minimum_available, peak_disk, minimum_disk_available, peak_k3s = measurements(rows)
lines += [
    "",
    "## Overall high-water marks",
    "",
    f"- Peak used RAM (MemTotal - MemAvailable): **{peak_memory / gib:.2f} GiB**",
    f"- Minimum available RAM: **{minimum_available / gib:.2f} GiB**",
    f"- Peak root-disk growth during the run: **{(peak_disk - initial_disk) / gib:.2f} GiB**",
    f"- Minimum root-disk space available: **{minimum_disk_available / gib:.2f} GiB**",
    f"- Peak `/var/lib/rancher/k3s` size: **{peak_k3s / gib:.2f} GiB**",
    "",
]
summary = "\n".join(lines)
destination.write_text(summary)
print(summary)
PY

  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    cat "${ARTIFACT_DIR}/resource-summary.md" >> "${GITHUB_STEP_SUMMARY}"
  fi
}

collect_diagnostics() {
  local diagnostics="${ARTIFACT_DIR}/failure"
  install -d -m 0755 "${diagnostics}/pod-logs"
  set +e
  {
    date --utc --iso-8601=seconds
    free -h
    df -h /
    du -sh /var/lib/rancher/k3s /root/mijn-bureau-infra 2>/dev/null
  } > "${diagnostics}/host.txt" 2>&1
  kubectl get nodes -o wide > "${diagnostics}/nodes.txt" 2>&1
  kubectl get deployment,statefulset,daemonset,pod,job -A -o wide > "${diagnostics}/workloads.txt" 2>&1
  kubectl get events -A --sort-by=.lastTimestamp > "${diagnostics}/events.txt" 2>&1
  kubectl describe pods -A > "${diagnostics}/pod-descriptions.txt" 2>&1
  helm list -A > "${diagnostics}/helm-releases.txt" 2>&1
  journalctl -u k3s --no-pager -n 1500 > "${diagnostics}/k3s-journal.txt" 2>&1

  kubectl get pods -A -o json 2>/dev/null | python3 -c '
import json, sys
for pod in json.load(sys.stdin).get("items", []):
    statuses = pod.get("status", {}).get("containerStatuses", [])
    if pod.get("status", {}).get("phase") != "Succeeded" and (
        not statuses or not all(item.get("ready") for item in statuses)
        or any(item.get("restartCount", 0) for item in statuses)
    ):
        print(pod["metadata"]["namespace"] + "/" + pod["metadata"]["name"])
' | while IFS=/ read -r namespace pod; do
    [ -n "${pod}" ] || continue
    kubectl logs -n "${namespace}" "${pod}" --all-containers --prefix --tail=250 \
      > "${diagnostics}/pod-logs/${namespace}_${pod}.log" 2>&1
    kubectl logs -n "${namespace}" "${pod}" --all-containers --prefix --tail=250 --previous \
      > "${diagnostics}/pod-logs/${namespace}_${pod}.previous.log" 2>&1
  done
  set -e
}

cluster_status() {
  kubectl get deployment,statefulset,daemonset,pod -A -o json | python3 -c '
import json, sys

items = json.load(sys.stdin).get("items", [])
pending = []
for item in items:
    kind = item["kind"]
    metadata = item["metadata"]
    spec = item.get("spec", {})
    status = item.get("status", {})
    namespace = metadata.get("namespace", "")
    object_name = metadata.get("name", "")
    name = f"{namespace}/{kind.lower()}/{object_name}"
    if kind == "Deployment":
        desired = spec.get("replicas", 1)
        available = status.get("availableReplicas", 0)
        if (status.get("observedGeneration", 0) < metadata.get("generation", 0)
                or status.get("updatedReplicas", 0) != desired
                or available != desired):
            pending.append(f"{name}: {available}/{desired} available")
    elif kind == "StatefulSet":
        desired = spec.get("replicas", 1)
        ready = status.get("readyReplicas", 0)
        if (status.get("observedGeneration", 0) < metadata.get("generation", 0)
                or ready != desired
                or status.get("currentRevision") != status.get("updateRevision")):
            pending.append(f"{name}: {ready}/{desired} ready")
    elif kind == "DaemonSet":
        desired = status.get("desiredNumberScheduled", 0)
        ready = status.get("numberReady", 0)
        if (status.get("observedGeneration", 0) < metadata.get("generation", 0)
                or ready != desired
                or status.get("updatedNumberScheduled", 0) != desired):
            pending.append(f"{name}: {ready}/{desired} ready")
    elif kind == "Pod" and status.get("phase") != "Succeeded":
        containers = status.get("containerStatuses", [])
        phase = status.get("phase", "Unknown")
        ready = sum(bool(container.get("ready")) for container in containers)
        if phase != "Running" or not containers or ready != len(containers):
            pending.append(f"{name}: {phase}, {ready}/{len(containers)} containers ready")

if pending:
    print("\n".join(pending[:80]))
    raise SystemExit(1)
print(f"ready: {len(items)} workload objects")
'
}

wait_for_cluster() {
  local label="$1" deadline status
  deadline=$((SECONDS + READY_TIMEOUT_SECONDS))
  echo "==> Waiting up to ${READY_TIMEOUT_SECONDS}s for ${label}"
  while ((SECONDS < deadline)); do
    if status="$(cluster_status 2>&1)"; then
      echo "${status}"
      return 0
    fi
    printf '%s\n' "${status}" > "${ARTIFACT_DIR}/${label}-pending.txt"
    echo "  not converged yet: $(head -1 <<<"${status}")"
    sleep 15
  done
  echo "ERROR: ${label} did not converge within ${READY_TIMEOUT_SECONDS}s" >&2
  cat "${ARTIFACT_DIR}/${label}-pending.txt" >&2
  return 1
}

assert_complete_stack() {
  local namespace workload_count pod_count
  echo "==> Asserting the complete deployment profile"
  for namespace in "${EXPECTED_NAMESPACES[@]}"; do
    kubectl get namespace "${namespace}" >/dev/null
    workload_count="$(kubectl -n "${namespace}" get deployment,statefulset -o name | wc -l)"
    if [ "${workload_count}" -eq 0 ]; then
      echo "ERROR: ${namespace} has no Deployment or StatefulSet" >&2
      return 1
    fi
    echo "ok   ${namespace}: ${workload_count} workload(s)"
  done

  # These are normal product exclusions, not a CI resource-saving profile.
  for namespace in mb-ollama mb-clamav mb-openproject; do
    if kubectl get namespace "${namespace}" >/dev/null 2>&1; then
      echo "ERROR: normally disabled application namespace exists: ${namespace}" >&2
      return 1
    fi
  done

  pod_count="$(kubectl get pods -A --no-headers | wc -l)"
  echo "ok   ${pod_count} cluster pod(s) are converged"
  kubectl get deployment,statefulset -A -o wide
}

local_conformance() {
  local label="$1"
  wait_for_cluster "${label}"
  assert_complete_stack
  SMOKE_INSECURE=1 bash "${REPO}/ci/smoke/smoke.sh" "${DOMAIN}"
}

run_bounded() {
  local phase="$1" duration="$2"
  shift 2
  set_phase "${phase}"
  timeout --signal=TERM --kill-after=120s "${duration}" "$@"
}

finish_run() {
  local rc=$?
  trap - EXIT
  stop_monitor
  summarize_resources || true
  if [ "${rc}" -ne 0 ]; then
    collect_diagnostics || true
  fi
  chmod -R a+rX "${ARTIFACT_DIR}" || true
  exit "${rc}"
}

run_full_test() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: fresh install must run as root (k3s is installed directly on the host)." >&2
    exit 2
  fi

  start_monitor
  trap finish_run EXIT
  trap 'exit 143' TERM
  trap 'exit 130' INT

  run_bounded first-deploy 55m "${REPO}/deploy.sh" "${DOMAIN}" ci@example.invalid
  set_phase first-conformance
  local_conformance first-deploy

  # A second complete deploy proves host-state reuse and script idempotence.
  run_bounded second-deploy 55m "${REPO}/deploy.sh" "${DOMAIN}" ci@example.invalid
  set_phase second-conformance
  local_conformance second-deploy

  # Then exercise a raw Helmfile re-apply and verify procedural state heals.
  run_bounded helmfile-convergence 40m "${REPO}/ci/convergence-check.sh"
  set_phase final-conformance
  local_conformance final

  set_phase complete
  echo "FRESH INSTALL PASS: complete self-signed stack deployed twice and converged"
}

case "${COMMAND}" in
  run)
    run_full_test
    ;;
  conformance)
    install -d -m 0755 "${ARTIFACT_DIR}"
    local_conformance manual
    ;;
  diagnostics)
    install -d -m 0755 "${ARTIFACT_DIR}"
    collect_diagnostics
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
