#!/usr/bin/env bash
# Fast source-shape checks; benchmark-startup.sh validates the built artifact.
set -euo pipefail

image_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${image_dir}/../.." && pwd)"
dockerfile="${image_dir}/Dockerfile"
php_patch="${repo_root}/patches/local/nextcloud-php-cache.patch"
workflow="${repo_root}/.github/workflows/nextcloud-image.yaml"
sync_hook="${image_dir}/hooks/10-opensuite-apps.sh"
office_deploy="${repo_root}/scripts/single-vps-deploy/04-nextcloud-office.sh"
richdocuments_patch="${image_dir}/patches/richdocuments-asset-mime.patch"
richdocuments_package_test="${image_dir}/test-richdocuments-package.sh"
template_picker_patch="${image_dir}/patch-template-picker.php"
template_picker_test="${image_dir}/test-template-picker-readiness.mjs"
template_picker_vue_test="${image_dir}/test-template-picker-vue-compat.mjs"
template_picker_browser_test="${image_dir}/test-template-picker-browser.mjs"
smoke="${repo_root}/ci/smoke/authenticated.mjs"
visual_smoke="${repo_root}/ci/smoke/visual-transitions.mjs"

require_literal() {
  local file="$1"
  local literal="$2"
  if ! grep -Fq -- "${literal}" "${file}"; then
    echo "ERROR: ${file#"${repo_root}/"} is missing: ${literal}" >&2
    exit 1
  fi
}

require_literal "${dockerfile}" 'COPY hooks/10-opensuite-apps.sh /usr/local/bin/opensuite-sync-apps'
require_literal "${dockerfile}" 'COPY richdocuments/ /usr/src/opensuite/richdocuments/'
require_literal "${dockerfile}" 'for phase in pre-installation pre-upgrade before-starting'
require_literal "${dockerfile}" 'ln -s /usr/local/bin/opensuite-sync-apps'
require_literal "${sync_hook}" 'for app in meetcal user_oidc richdocuments whiteboard; do'
require_literal "${sync_hook}" 'stage_root="${OPENSUITE_STAGE_ROOT:-/usr/src/opensuite}"'
require_literal "${sync_hook}" 'core_stage_root="${OPENSUITE_CORE_STAGE_ROOT:-/usr/src/nextcloud}"'
require_literal "${sync_hook}" 'nextcloud_root="${NEXTCLOUD_ROOT:-/var/www/html}"'
require_literal "${sync_hook}" 'dist/files-init-opensuite-tp2.js'
require_literal "${sync_hook}" 'dist/files-init-opensuite-tp2.js.map'
require_literal "${sync_hook}" 'apps/files/lib/Controller/ViewController.php'
require_literal "${sync_hook}" 'rsync -a --checksum "${source}" "${target}"'
require_literal "${dockerfile}" 'php /usr/local/bin/opensuite-patch-template-picker /usr/src/nextcloud'

# NC34's Document entry resolves its async wrapper before the lazy child ref is
# mounted. Pin the exact upstream bundle/map/controller preimages, publish a
# new cache-safe entry pathname, and await the import before wrapper creation.
require_literal "${template_picker_patch}" "const FILES_INIT_SHA256 = 'b70e746da0f331f19e8deaf494f806baea2decd4de9964d1f2c99dbeb136fc18';"
require_literal "${template_picker_patch}" "const FILES_INIT_MAP_SHA256 = '208945a2b732e8e863915e98544bac78ea6958898d149c3f23ab756897362ea8';"
require_literal "${template_picker_patch}" "const TEMPLATE_PICKER_CHUNK_SHA256 = '0400acc742f52d27ad940a2fdc3cb216b1181e35d05882e7797ad24e991d9710';"
require_literal "${template_picker_patch}" "const TEMPLATE_PICKER_CHUNK_MAP_SHA256 = 'fdce7694964d98df40e135d37a26d92d3d7a2e167da6697c0f4b88e3e1fe7ecc';"
require_literal "${template_picker_patch}" "const TEMPLATE_PICKER_MAP_FILE = '7497-7497.js?v=4c13f30ae7ab10413c2e';"
require_literal "${template_picker_patch}" "const TEMPLATE_PICKER_RUNTIME_URL = '7497-7497.js?v=94a5bd32402d33b444dc';"
require_literal "${template_picker_patch}" "str_ends_with(\$source, 'apps/files/src/views/TemplatePicker.vue')"
require_literal "${template_picker_patch}" "throw new RuntimeException('expected exactly one physical NC34 TemplatePicker source map');"
require_literal "${template_picker_patch}" "const PATCHED_BUNDLE_SHA256 = '3a2afc0ea1650d1073b14284e27d772a7709c028f1a1a724e041c4f863c3e7d7';"
require_literal "${template_picker_patch}" 'opensuiteTemplatePickerLoader=()=>Promise.all([t.e(4208),t.e(7497)]).then(t.bind(t,27497))'
require_literal "${template_picker_patch}" ';let tn=null;const opensuiteTemplatePickerLoader='
require_literal "${template_picker_patch}" 'tn||=opensuiteTemplatePickerLoader()'
require_literal "${template_picker_patch}" 'const{default:i}=await tn;if(!nn)'
require_literal "${template_picker_patch}" "const NEW_CONTROLLER = \"\\t\\tUtil::addInitScript('files', 'init-opensuite-tp2');\";"
require_literal "${template_picker_test}" 'NC34 immediate wrapper reproduces the unresolved lazy child open race'
require_literal "${template_picker_test}" 'candidate holds wrapper construction on one cached import for concurrent callers'
require_literal "${template_picker_test}" 'candidate import failure rejects every concurrent caller'
require_literal "${template_picker_test}" 'generated lazy loader retains module-scope Webpack runtime when the handler shadows t'
require_literal "${template_picker_vue_test}" 'const { default: TemplatePickerComponent } = await TemplatePickerVue;'
require_literal "${template_picker_vue_test}" 'assert.equal(wrapper, undefined);'
require_literal "${template_picker_browser_test}" 'url.pathname === "/dist/7497-7497.js"'
require_literal "${template_picker_browser_test}" 'url.searchParams.get("v") === "94a5bd32402d33b444dc"'
require_literal "${sync_hook}" 'chunk="dist/7497-7497.js"'
require_literal "${sync_hook}" 'installed Nextcloud TemplatePicker chunk does not match the pinned image'
require_literal "${image_dir}/test-app-sync.sh" 'app sync accepted a mismatched installed TemplatePicker chunk'
require_literal "${visual_smoke}" 'url.pathname === "/ocs/v2.php/apps/files/api/v1/templates/create"'
require_literal "${visual_smoke}" 'fixture.created = true;'
require_literal "${visual_smoke}" 'cleanup.before === 200 && cleanup.deleted === 204 && cleanup.after === 404'

# The picker fix must be a reproducible NC34 app pin, not a live PVC mutation
# or an unversioned app-store update. The official artifact digest and complete
# signed manifest are checked before the one-file, exact-context patch; the
# resulting package contract verifies every unchanged file and patched hash.
require_literal "${workflow}" 'RICHDOCUMENTS_VERSION: v11.0.1'
require_literal "${workflow}" 'RICHDOCUMENTS_SHA256: 1952b5bfa0ddb24a4c125a9c28b12798a634a1263e88136d3244a86408c4c996'
require_literal "${workflow}" 'echo "${RICHDOCUMENTS_SHA256}  richdocuments.tar.gz" | sha256sum --check --strict'
require_literal "${workflow}" 'bash test-richdocuments-package.sh richdocuments'
require_literal "${richdocuments_package_test}" 'bash "$0" "${app_dir}" upstream'
require_literal "${richdocuments_package_test}" 'patch --fuzz=0 --no-backup-if-mismatch'
require_literal "${richdocuments_package_test}" 'patches/richdocuments-asset-mime.patch'
require_literal "${richdocuments_package_test}" 'bash "$0" "${app_dir}" patched'
require_literal "${workflow}" 'bash test-app-sync.sh richdocuments'
require_literal "${richdocuments_patch}" '+		$mimeType = $node->getMimeType();'
require_literal "${richdocuments_patch}" "+		\$response->addHeader('Content-Type', \$mimeType !== '' ? \$mimeType : 'application/octet-stream');"
require_literal "${office_deploy}" 'RICHDOCUMENTS_VERSION=11.0.1'
require_literal "${office_deploy}" 'echo "ERROR: expected enabled richdocuments $1, found ${version:-missing}"'

# Browser acceptance must reject the exact deployed regression: generic MIME,
# redirected/HTML/wrong JPEG bodies, one-use URLs Collabora never consumed, or
# message-only "success" without two visibly rendered insertions.
require_literal "${smoke}" 'headType !== "image/jpeg"'
require_literal "${smoke}" 'assetDigest !== jpegHash'
require_literal "${smoke}" '/Unknown image format/i'
require_literal "${smoke}" 'firstAssetUrl === secondAssetUrl'

# Disabling JIT requires both directives. Leaving PHP 8.4's non-zero buffer in
# place can enable JIT again even if the mode's spelling/default changes.
require_literal "${php_patch}" '+    opcache.jit=disable'
require_literal "${php_patch}" '+    opcache.jit_buffer_size=0'

echo "Nextcloud source-shape checks passed"
