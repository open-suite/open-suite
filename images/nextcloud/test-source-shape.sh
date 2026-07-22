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
require_literal "${sync_hook}" 'for app in meetcal user_oidc richdocuments; do'
require_literal "${sync_hook}" 'stage_root="${OPENSUITE_STAGE_ROOT:-/usr/src/opensuite}"'
require_literal "${sync_hook}" 'nextcloud_root="${NEXTCLOUD_ROOT:-/var/www/html}"'

# The picker fix must be a reproducible NC34 app pin, not a live PVC mutation
# or an unversioned app-store update. The official artifact digest is checked
# before the unmodified official package is copied into the image.
require_literal "${workflow}" 'RICHDOCUMENTS_VERSION: v11.0.1'
require_literal "${workflow}" 'RICHDOCUMENTS_SHA256: 1952b5bfa0ddb24a4c125a9c28b12798a634a1263e88136d3244a86408c4c996'
require_literal "${workflow}" 'echo "${RICHDOCUMENTS_SHA256}  richdocuments.tar.gz" | sha256sum --check --strict'
require_literal "${workflow}" 'bash test-richdocuments-package.sh richdocuments'
require_literal "${workflow}" 'bash test-app-sync.sh richdocuments'
require_literal "${office_deploy}" 'RICHDOCUMENTS_VERSION=11.0.1'
require_literal "${office_deploy}" 'echo "ERROR: expected enabled richdocuments $1, found ${version:-missing}"'

# Disabling JIT requires both directives. Leaving PHP 8.4's non-zero buffer in
# place can enable JIT again even if the mode's spelling/default changes.
require_literal "${php_patch}" '+    opcache.jit=disable'
require_literal "${php_patch}" '+    opcache.jit_buffer_size=0'

echo "Nextcloud source-shape checks passed"
