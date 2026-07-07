#!/usr/bin/env bash
# Install the daily demo-data refresh as a host cron on the single VPS.
# Run as root on the box. Reads creds from the `demo-seed` secret at runtime.
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)/seed-demo.sh"
install -D -m 0755 "${SRC}" /opt/opensuite/seed-demo.sh
cat > /etc/cron.d/opensuite-demo-seed <<'EOF'
# Open Suite: refresh demo data daily (keeps calendar events upcoming and every
# portal widget populated). Idempotent — overwrites fixed ids, skips existing.
# Runs at 06:00 UTC, after the nightly smoke (05:17), so the seed's purge of
# smoke-test residue leaves the demo clean for the day.
0 6 * * * root KUBECONFIG=/etc/rancher/k3s/k3s.yaml /opt/opensuite/seed-demo.sh >> /var/log/opensuite-demo-seed.log 2>&1
EOF
echo "Installed /opt/opensuite/seed-demo.sh + /etc/cron.d/opensuite-demo-seed"
