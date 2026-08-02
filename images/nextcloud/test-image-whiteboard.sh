#!/usr/bin/env bash
# Verify Whiteboard in a built Open Suite Nextcloud image without a database.
# Usage: ./test-image-whiteboard.sh IMAGE
set -euo pipefail

image="${1:?Usage: $0 IMAGE}"
tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT

docker run --rm --pull=never --entrypoint cat "${image}" \
  /usr/src/nextcloud/dist/files-init-opensuite-tp1.js \
  > "${tmp}/files-init-opensuite-tp1.js"
node --check "${tmp}/files-init-opensuite-tp1.js"
test "$(sha256sum "${tmp}/files-init-opensuite-tp1.js" | cut -d ' ' -f 1)" \
  = f3140718058e3b5c75f3e1383d8c9cabadfde32eb52ae56f93117ffc0e7c2031
! grep -Fq 'sourceMappingURL=' "${tmp}/files-init-opensuite-tp1.js"

docker run --rm --pull=never --entrypoint sh "${image}" -ec '
  source=/usr/src/opensuite/whiteboard
  target=/var/www/html/custom_apps/whiteboard

  test "$(sed -n "s:.*<version>\([^<]*\)</version>.*:\1:p" "${source}/appinfo/info.xml")" = 1.5.9
  grep -Fq "<nextcloud min-version=\"28\" max-version=\"34\"/>" "${source}/appinfo/info.xml"
  grep -Fq "registerEventListener(LoadViewer::class, LoadViewerListener::class)" "${source}/lib/AppInfo/Application.php"
  grep -Fq "mimes:[\"application/vnd.excalidraw+json\"]" "${source}/js/whiteboard-main.mjs"
  grep -Fq "\"whiteboard\": [\"application/vnd.excalidraw+json\"]" /usr/src/nextcloud/resources/config/mimetypemapping.dist.json
  grep -Fq "\"application/vnd.excalidraw+json\": \"whiteboard\"" /usr/src/nextcloud/resources/config/mimetypealiases.dist.json
  test -x /usr/local/bin/opensuite-configure-whiteboard
  test "$(readlink -f /docker-entrypoint-hooks.d/before-starting/20-opensuite-whiteboard.sh)" = /usr/local/bin/opensuite-configure-whiteboard
  grep -Fq "e.default.mixins=[...(e.default.mixins||[]),{mounted:ir}]" /usr/src/nextcloud/dist/files-init-opensuite-tp1.js
  grep -Fq "if(await ar" /usr/src/nextcloud/dist/files-init-opensuite-tp1.js
  grep -Fq "Util::addInitScript('"'"'files'"'"', '"'"'init-opensuite-tp1'"'"');" \
    /usr/src/nextcloud/apps/files/lib/Controller/ViewController.php
  cmp /usr/src/nextcloud/dist/7497-7497.js /var/www/html/dist/7497-7497.js

  # Simulate an old PVC app, then reconcile twice. --delete must remove stale
  # release files and the second run must be byte-for-byte idempotent.
  rm -rf "${target}"
  mkdir -p "${target}/appinfo"
  printf "<info><version>0.0.0</version></info>\n" >"${target}/appinfo/info.xml"
  touch "${target}/removed-in-new-release"
  printf "stale bundle\n" >/var/www/html/dist/files-init-opensuite-tp1.js
  printf "stale controller\n" >/var/www/html/apps/files/lib/Controller/ViewController.php
  /usr/local/bin/opensuite-sync-apps
  test ! -e "${target}/removed-in-new-release"
  cmp /usr/src/nextcloud/dist/files-init-opensuite-tp1.js \
    /var/www/html/dist/files-init-opensuite-tp1.js
  cmp /usr/src/nextcloud/apps/files/lib/Controller/ViewController.php \
    /var/www/html/apps/files/lib/Controller/ViewController.php
  first="$(find "${target}" -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum)"
  /usr/local/bin/opensuite-sync-apps
  second="$(find "${target}" -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum)"
  test "${first}" = "${second}"
  test "$(sed -n "s:.*<version>\([^<]*\)</version>.*:\1:p" "${target}/appinfo/info.xml")" = 1.5.9
'

echo "Nextcloud core override and Whiteboard image upgrade/idempotence contracts verified"
