#!/usr/bin/env bash
# Static regression guard for the Collabora-only startup optimization. Run
# against the pinned infra checkout after applying patches/local.
set -euo pipefail

INFRA="${1:?Usage: $0 <patched-infra-dir>}"
VALUES="${INFRA}/helmfile/apps/collabora/values-collabora.yaml.gotmpl"
DEPLOYMENT="${INFRA}/helmfile/apps/collabora/charts/collabora/templates/deployment.yaml"

require_literal() {
  local expected="$1"
  if ! grep -Fq -- "${expected}" "${VALUES}"; then
    echo "ERROR: Collabora values are missing: ${expected}" >&2
    exit 1
  fi
}

# Keep the measured preload set and skip only the image's unused, internal
# dummy certificate generation.
require_literal 'dictionaries: "en_GB en_US nl"'
require_literal 'name: DONT_GEN_SSL_CERT'
require_literal 'value: "true"'

# Ensure the app value is still rendered into the CODE image's startup
# environment, where coolwsd maps it to allowed_languages.
grep -Fq 'value: {{ .Values.collabora.dictionaries | quote }}' "${DEPLOYMENT}"

# Security and fidelity invariants: ingress TLS termination and the WOPI host
# allowlist remain in force, while no jail capability or font-removal shortcut
# is introduced.
require_literal '--o:ssl.enable=false'
require_literal '--o:ssl.termination=true'
require_literal '--o:storage.wopi.alias_groups.mode=groups'
require_literal '--o:storage.wopi.alias_groups.group[0].host=https://'
require_literal '--o:storage.wopi.alias_groups.group[1].host=https://'

if grep -Eq -- 'security\.capabilities=false|mount_jail_tree=false|fonts_missing.*ignore' "${VALUES}"; then
  echo "ERROR: Collabora startup tuning weakened jail or font diagnostics" >&2
  exit 1
fi

echo "Collabora startup performance and security contracts verified"
