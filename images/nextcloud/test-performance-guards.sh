#!/usr/bin/env bash
# Regression guards for the startup ordering and measured PHP settings.
set -euo pipefail

image_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${image_dir}/../.." && pwd)"
dockerfile="${image_dir}/Dockerfile"
php_patch="${repo_root}/patches/local/nextcloud-php-cache.patch"

require_literal() {
  local file="$1"
  local literal="$2"
  if ! grep -Fq -- "${literal}" "${file}"; then
    echo "ERROR: ${file#"${repo_root}/"} is missing: ${literal}" >&2
    exit 1
  fi
}

require_literal "${dockerfile}" 'COPY hooks/10-opensuite-apps.sh /usr/local/bin/opensuite-sync-apps'
require_literal "${dockerfile}" 'for phase in pre-installation pre-upgrade before-starting'
require_literal "${dockerfile}" 'ln -s /usr/local/bin/opensuite-sync-apps'

# Disabling JIT requires both directives. Leaving PHP 8.4's non-zero buffer in
# place can enable JIT again even if the mode's spelling/default changes.
require_literal "${php_patch}" '+    opcache.jit=disable'
require_literal "${php_patch}" '+    opcache.jit_buffer_size=0'

echo "Nextcloud performance guards passed"
