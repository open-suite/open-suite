#!/usr/bin/env bash
# Prove an existing 11.0.0 custom_apps PVC is replaced by the pinned package
# and that repeated startup-hook runs are idempotent.
set -euo pipefail

app_source="${1:-richdocuments}"
image_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT

mkdir -p \
  "${tmp}/stage/meetcal" \
  "${tmp}/stage/user_oidc" \
  "${tmp}/stage/richdocuments" \
  "${tmp}/stage/whiteboard" \
  "${tmp}/core/dist" \
  "${tmp}/core/apps/files/lib/Controller" \
  "${tmp}/nextcloud/custom_apps/richdocuments/appinfo" \
  "${tmp}/nextcloud/dist" \
  "${tmp}/nextcloud/apps/files/lib/Controller"
cp -a "${app_source}/." "${tmp}/stage/richdocuments/"
touch \
  "${tmp}/stage/meetcal/fixture" \
  "${tmp}/stage/user_oidc/fixture" \
  "${tmp}/stage/whiteboard/fixture"
printf 'patched bundle\n' > "${tmp}/core/dist/files-init-opensuite-tp1.js"
printf 'pinned picker chunk\n' > "${tmp}/core/dist/7497-7497.js"
printf 'patched controller\n' > "${tmp}/core/apps/files/lib/Controller/ViewController.php"
printf 'stale bundle\n' > "${tmp}/nextcloud/dist/files-init-opensuite-tp1.js"
cp "${tmp}/core/dist/7497-7497.js" "${tmp}/nextcloud/dist/7497-7497.js"
printf 'stale controller\n' > "${tmp}/nextcloud/apps/files/lib/Controller/ViewController.php"
cat > "${tmp}/nextcloud/custom_apps/richdocuments/appinfo/info.xml" <<'XML'
<info><version>11.0.0</version></info>
XML
touch "${tmp}/nextcloud/custom_apps/richdocuments/stale-11.0.0-file"

run_sync() {
  OPENSUITE_STAGE_ROOT="${tmp}/stage" \
    OPENSUITE_CORE_STAGE_ROOT="${tmp}/core" \
    NEXTCLOUD_ROOT="${tmp}/nextcloud" \
    sh "${image_dir}/hooks/10-opensuite-apps.sh"
}

run_sync
grep -Fq '<version>11.0.1</version>' \
  "${tmp}/nextcloud/custom_apps/richdocuments/appinfo/info.xml"
test ! -e "${tmp}/nextcloud/custom_apps/richdocuments/stale-11.0.0-file"
cmp "${tmp}/core/dist/files-init-opensuite-tp1.js" \
  "${tmp}/nextcloud/dist/files-init-opensuite-tp1.js"
cmp "${tmp}/core/apps/files/lib/Controller/ViewController.php" \
  "${tmp}/nextcloud/apps/files/lib/Controller/ViewController.php"

find "${tmp}/nextcloud/custom_apps/richdocuments" -type f -print0 \
  | sort -z | xargs -0 sha256sum > "${tmp}/first-sync.sha256"
run_sync
find "${tmp}/nextcloud/custom_apps/richdocuments" -type f -print0 \
  | sort -z | xargs -0 sha256sum > "${tmp}/second-sync.sha256"
cmp "${tmp}/first-sync.sha256" "${tmp}/second-sync.sha256"

first_core="$(find "${tmp}/nextcloud/dist/files-init-opensuite-tp1.js" \
  "${tmp}/nextcloud/apps/files/lib/Controller/ViewController.php" \
  -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum)"
run_sync
second_core="$(find "${tmp}/nextcloud/dist/files-init-opensuite-tp1.js" \
  "${tmp}/nextcloud/apps/files/lib/Controller/ViewController.php" \
  -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum)"
test "${first_core}" = "${second_core}"

echo "richdocuments and pinned NC34 core override PVC sync is idempotent"
