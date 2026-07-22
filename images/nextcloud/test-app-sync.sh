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
  "${tmp}/nextcloud/custom_apps/richdocuments/appinfo"
cp -a "${app_source}/." "${tmp}/stage/richdocuments/"
touch \
  "${tmp}/stage/meetcal/fixture" \
  "${tmp}/stage/user_oidc/fixture" \
  "${tmp}/stage/whiteboard/fixture"
cat > "${tmp}/nextcloud/custom_apps/richdocuments/appinfo/info.xml" <<'XML'
<info><version>11.0.0</version></info>
XML
touch "${tmp}/nextcloud/custom_apps/richdocuments/stale-11.0.0-file"

run_sync() {
  OPENSUITE_STAGE_ROOT="${tmp}/stage" NEXTCLOUD_ROOT="${tmp}/nextcloud" \
    sh "${image_dir}/hooks/10-opensuite-apps.sh"
}

run_sync
grep -Fq '<version>11.0.1</version>' \
  "${tmp}/nextcloud/custom_apps/richdocuments/appinfo/info.xml"
test ! -e "${tmp}/nextcloud/custom_apps/richdocuments/stale-11.0.0-file"

find "${tmp}/nextcloud/custom_apps/richdocuments" -type f -print0 \
  | sort -z | xargs -0 sha256sum > "${tmp}/first-sync.sha256"
run_sync
find "${tmp}/nextcloud/custom_apps/richdocuments" -type f -print0 \
  | sort -z | xargs -0 sha256sum > "${tmp}/second-sync.sha256"
cmp "${tmp}/first-sync.sha256" "${tmp}/second-sync.sha256"

echo "richdocuments 11.0.0 -> 11.0.1 PVC sync is idempotent"
