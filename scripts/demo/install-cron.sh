#!/usr/bin/env bash
# Install the daily demo reset as a systemd timer on the single VPS.
# Run as root on the box. Reads creds from the `demo-seed` secret at runtime.
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)/seed-demo.sh"
install -D -m 0755 "${SRC}" /opt/opensuite/seed-demo.sh
cat > /etc/systemd/system/opensuite-demo-reset.service <<'EOF'
[Unit]
Description=Reset Open Suite public demo data
After=k3s.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment=KUBECONFIG=/etc/rancher/k3s/k3s.yaml
ExecStart=/opt/opensuite/seed-demo.sh
StandardOutput=append:/var/log/opensuite-demo-reset.log
StandardError=append:/var/log/opensuite-demo-reset.log
EOF
cat > /etc/systemd/system/opensuite-demo-reset.timer <<'EOF'
[Unit]
Description=Reset Open Suite public demo every morning

[Timer]
OnCalendar=*-*-* 06:00:00 UTC
Persistent=true
RandomizedDelaySec=0
Unit=opensuite-demo-reset.service

[Install]
WantedBy=timers.target
EOF
cat > /etc/logrotate.d/opensuite-demo-reset <<'EOF'
/var/log/opensuite-demo-reset.log {
    daily
    rotate 14
    size 1M
    compress
    missingok
    notifempty
    copytruncate
}
EOF
rm -f /etc/cron.d/opensuite-demo-seed /etc/logrotate.d/opensuite-demo-seed
systemctl daemon-reload
systemctl enable --now opensuite-demo-reset.timer
systemctl start opensuite-demo-reset.service
echo "Installed and ran opensuite-demo-reset.service; next run:"
systemctl list-timers opensuite-demo-reset.timer --no-pager
