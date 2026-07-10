#!/usr/bin/env bash
# Usage: ./scripts/local-vm/up.sh [ref]
#
# Fresh-VM deploy test on a local machine (macOS + Lima). Creates an Ubuntu
# 24.04 VM (8 CPU / 16 GiB / 60 GiB — the stack idles ~9 GiB), clones this
# repo at [ref] (default: main) inside it, and runs deploy.sh in selfsigned
# TLS mode with the wildcard DNS trick:
#
#   domain = 127.0.0.1.sslip.io  →  *.127.0.0.1.sslip.io resolves to
#   127.0.0.1 everywhere: on the host (Lima forwards 80/443 into the VM),
#   inside the VM (Traefik hostports), and in-cluster (CoreDNS rewrite, 02).
#
# Requires: lima (brew install lima). Idempotent-ish: re-running reuses the
# VM and re-runs the deploy (which is itself idempotent).
set -euo pipefail

REF="${1:-main}"
VM=opensuite-local
DOMAIN=127.0.0.1.sslip.io
REPO=https://github.com/open-suite/open-suite

# Capture first: with pipefail, `limactl | grep -q` can die of SIGPIPE on a
# match (grep exits early) and read as "VM missing".
EXISTING="$(limactl list --format '{{.Name}}' 2>/dev/null || true)"
if ! printf '%s\n' "${EXISTING}" | grep -qx "${VM}"; then
  limactl create --name="${VM}" --tty=false - <<'LIMA'
vmType: vz
os: Linux
images:
  - location: https://cloud-images.ubuntu.com/releases/noble/release/ubuntu-24.04-server-cloudimg-arm64.img
    arch: aarch64
  - location: https://cloud-images.ubuntu.com/releases/noble/release/ubuntu-24.04-server-cloudimg-amd64.img
    arch: x86_64
cpus: 8
memory: 16GiB
disk: 60GiB
mounts: []
portForwards:
  - guestPort: 443
    hostPort: 443
  - guestPort: 80
    hostPort: 80
LIMA
fi
limactl start "${VM}" 2>/dev/null || true

echo "==> Cloning ${REPO}@${REF} in the VM and deploying (this takes a while)"
limactl shell "${VM}" sudo bash -s -- "${REF}" "${DOMAIN}" <<'VMEOF'
set -euo pipefail
REF="$1"; DOMAIN="$2"
export DEBIAN_FRONTEND=noninteractive
command -v git >/dev/null || apt-get -qq update && apt-get -qq install -y git curl openssl >/dev/null
if [ ! -d /root/open-suite/.git ]; then
  git clone -q https://github.com/open-suite/open-suite /root/open-suite
fi
git -C /root/open-suite fetch -q origin
git -C /root/open-suite checkout -q "origin/${REF}" 2>/dev/null || git -C /root/open-suite checkout -q "${REF}"
cd /root/open-suite
export OPEN_SUITE_TLS_MODE=selfsigned
export OPEN_SUITE_DEMO_MODE=true
MIJNBUREAU_MASTER_PASSWORD='localMasterPassword123' \
  ./deploy.sh "${DOMAIN}" local@example.invalid
VMEOF

echo
echo "Deploy finished. Portal: https://bridge.${DOMAIN} (self-signed cert —"
echo "the browser will warn). Demo login: johndoe / myStrongPassword123."
echo "Smoke: bash ci/smoke/smoke.sh ${DOMAIN}"
echo "Tear down: limactl delete -f ${VM}"
