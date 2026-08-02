#!/usr/bin/env bash
# Verify Whiteboard in a built Open Suite Nextcloud image without a database.
# Usage: ./test-image-whiteboard.sh IMAGE
set -euo pipefail

image="${1:?Usage: $0 IMAGE}"
tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT

docker run --rm --pull=never --entrypoint cat "${image}" \
  /usr/src/nextcloud/dist/files-init-opensuite-tp2.js \
  > "${tmp}/files-init-opensuite-tp2.js"
node --check "${tmp}/files-init-opensuite-tp2.js"
test "$(sha256sum "${tmp}/files-init-opensuite-tp2.js" | cut -d ' ' -f 1)" \
  = d0c0c4e579d36ccdcbccccb9bdcd483c04e945a2bcc71c99524431bd9df88f3c
grep -Fq 'sourceMappingURL=files-init-opensuite-tp2.js.map?v=' \
  "${tmp}/files-init-opensuite-tp2.js"

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
  test "$(sha256sum /usr/src/nextcloud/dist/7497-7497.js | cut -d " " -f 1)" = 0400acc742f52d27ad940a2fdc3cb216b1181e35d05882e7797ad24e991d9710
  grep -Fq "opensuiteTemplatePickerLoader=()=>Promise.all([t.e(4208),t.e(7497)]).then(t.bind(t,27497))" /usr/src/nextcloud/dist/files-init-opensuite-tp2.js
  grep -Fq "tn||=opensuiteTemplatePickerLoader();const{default:i}=await tn;if(!nn)" /usr/src/nextcloud/dist/files-init-opensuite-tp2.js
  grep -Fq "TemplatePickerVue ??= import('"'"'../views/TemplatePicker.vue'"'"');" /usr/src/nextcloud/dist/files-init-opensuite-tp2.js.map
  grep -Fq "\"mappings\":\"\"" /usr/src/nextcloud/dist/files-init-opensuite-tp2.js.map
  ! grep -Fq "const TemplatePickerVue = defineAsyncComponent(() => import('"'"'../views/TemplatePicker.vue'"'"'));" /usr/src/nextcloud/dist/files-init-opensuite-tp2.js.map
  grep -Fq "Util::addInitScript('"'"'files'"'"', '"'"'init-opensuite-tp2'"'"');" \
    /usr/src/nextcloud/apps/files/lib/Controller/ViewController.php

  # Simulate an old PVC app, then reconcile twice. --delete must remove stale
  # release files and the second run must be byte-for-byte idempotent.
  rm -rf "${target}"
  mkdir -p "${target}/appinfo"
  printf "<info><version>0.0.0</version></info>\n" >"${target}/appinfo/info.xml"
  touch "${target}/removed-in-new-release"
  # The raw image has not run the official entrypoint, so initialize the exact
  # pinned chunk that the fail-closed same-version PVC sync requires.
  mkdir -p /var/www/html/dist
  cp /usr/src/nextcloud/dist/7497-7497.js /var/www/html/dist/7497-7497.js
  printf "stale bundle\n" >/var/www/html/dist/files-init-opensuite-tp2.js
  printf "stale map\n" >/var/www/html/dist/files-init-opensuite-tp2.js.map
  mkdir -p /var/www/html/apps/files/lib/Controller
  printf "stale controller\n" >/var/www/html/apps/files/lib/Controller/ViewController.php
  /usr/local/bin/opensuite-sync-apps
  test ! -e "${target}/removed-in-new-release"
  cmp /usr/src/nextcloud/dist/files-init-opensuite-tp2.js \
    /var/www/html/dist/files-init-opensuite-tp2.js
  cmp /usr/src/nextcloud/dist/files-init-opensuite-tp2.js.map \
    /var/www/html/dist/files-init-opensuite-tp2.js.map
  cmp /usr/src/nextcloud/apps/files/lib/Controller/ViewController.php \
    /var/www/html/apps/files/lib/Controller/ViewController.php
  first="$(find "${target}" -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum)"
  /usr/local/bin/opensuite-sync-apps
  second="$(find "${target}" -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum)"
  test "${first}" = "${second}"
  test "$(sed -n "s:.*<version>\([^<]*\)</version>.*:\1:p" "${target}/appinfo/info.xml")" = 1.5.9
'

echo "Nextcloud core override and Whiteboard image upgrade/idempotence contracts verified"
