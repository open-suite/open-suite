#!/usr/bin/env bash
# Fail-closed source and rendered-chart contract for Nextcloud Whiteboard.
# Usage: ./ci/test-nextcloud-whiteboard.sh [patched-infra-dir]
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
workflow="${repo}/.github/workflows/nextcloud-image.yaml"
dockerfile="${repo}/images/nextcloud/Dockerfile"
hook="${repo}/images/nextcloud/hooks/10-opensuite-apps.sh"
backend_patch="${repo}/patches/local/nextcloud-whiteboard-backend.patch"
config_hook="${repo}/images/nextcloud/hooks/20-opensuite-whiteboard.sh"
demo_values="${repo}/helmfile/demo-values.yaml.tmpl"
smoke="${repo}/ci/smoke/authenticated.mjs"

require_literal() {
  local file="$1" literal="$2"
  if ! grep -Fq -- "${literal}" "${file}"; then
    echo "ERROR: ${file#"${repo}/"} is missing: ${literal}" >&2
    exit 1
  fi
}

# Immutable upstream package: version, URL and independently calculated digest
# must all move together. sha256sum --check --strict rejects partial/malformed
# digest input before extraction.
require_literal "${workflow}" 'WHITEBOARD_VERSION: v1.5.9'
require_literal "${workflow}" 'WHITEBOARD_SHA256: 195e5d0b19fbb7e176bd2c89babfd5514aef0224afe5d0ef239304e84046a1fe'
require_literal "${workflow}" 'https://github.com/nextcloud-releases/whiteboard/releases/download/${WHITEBOARD_VERSION}/whiteboard-${WHITEBOARD_VERSION}.tar.gz'
require_literal "${workflow}" 'sha256sum --check --strict'
require_literal "${workflow}" 'openssl_x509_parse($manifest["certificate"])'
require_literal "${workflow}" '($certificate["subject"]["CN"] ?? null) !== "whiteboard"'
require_literal "${workflow}" 'hash_file("sha512", "whiteboard/appinfo/info.xml")'

# Image and PVC lifecycle: every required app is present, upgrades replace old
# code before occ upgrade, and same-version restarts reconcile it again.
require_literal "${dockerfile}" 'COPY whiteboard/ /usr/src/opensuite/whiteboard/'
require_literal "${hook}" 'for app in meetcal user_oidc whiteboard; do'
require_literal "${hook}" 'rsync -a --delete "${source}/" "/var/www/html/custom_apps/${app}/"'
require_literal "${hook}" 'ERROR: image is missing required app source:'
require_literal "${dockerfile}" 'pre-installation pre-upgrade before-starting'
require_literal "${dockerfile}" 'before-starting/20-opensuite-whiteboard.sh'
require_literal "${config_hook}" 'php /var/www/html/occ app:enable whiteboard'
require_literal "${config_hook}" 'config:app:set whiteboard collabBackendUrl'
require_literal "${config_hook}" 'config:app:set whiteboard jwt_secret_key'
require_literal "${config_hook}" 'WHITEBOARD_COLLAB_BACKEND_URL:?'
require_literal "${config_hook}" 'WHITEBOARD_JWT_SECRET:?'

# Nextcloud 34 owns the MIME mapping. The baked app must register LoadViewer
# and the JavaScript Viewer handler for the exact canonical MIME.
require_literal "${dockerfile}" '"whiteboard": ["application/vnd.excalidraw+json"]'
require_literal "${dockerfile}" '"application/vnd.excalidraw+json": "whiteboard"'
require_literal "${dockerfile}" 'registerEventListener(LoadViewer::class, LoadViewerListener::class)'
require_literal "${dockerfile}" 'mimes:[\"application/vnd.excalidraw+json\"]'

# Enabling/configuration is declarative and strict on every before-starting
# path, not only the chart's fresh-install hook.
if grep -Fq 'app:enable whiteboard ||' "${config_hook}"; then
  echo "ERROR: Whiteboard enablement must fail closed" >&2
  exit 1
fi

# The accepted browser contract creates and edits a real board, checks MIME and
# persisted content through WebDAV, reloads the editor, and cleans up. app:list
# is intentionally not an acceptance signal.
for literal in \
  'New whiteboard' \
  '.excalidraw__canvas' \
  'application/vnd.excalidraw+json' \
  'availableHandlers' \
  'opensuite-whiteboard-smoke-marker'; do
  require_literal "${smoke}" "${literal}"
done
if grep -Fq 'occ app:list' "${smoke}"; then
  echo "ERROR: browser contract must not substitute app:list for editing" >&2
  exit 1
fi

# v1.5.9 requires a coordinator-elected syncer for durable Nextcloud saves.
# Pin that backend by tag+digest, retain one shared generated secret, keep it
# same-origin behind auth-gate, and preserve a default-deny pod boundary.
for literal in \
  'nextcloud-releases/whiteboard' \
  'tag: v1.5.9' \
  'sha256:b60b7633f90d106ac6922f9bc27e1a1ca2442488b740fefdae4c812f34e9cebc' \
  'helm.sh/resource-policy: keep' \
  'common.secrets.passwords.manage' \
  'readOnlyRootFilesystem: true' \
  'capabilities: { drop: ["ALL"] }' \
  'automountServiceAccountToken: false' \
  'kubernetes.io/metadata.name: kube-system' \
  'app.kubernetes.io/name: traefik' \
  'opensuite-auth-gate@kubernetescrd' \
  'WHITEBOARD_JWT_SECRET'; do
  if ! grep -Fq -- "${literal}" "${backend_patch}" "${demo_values}"; then
    echo "ERROR: Whiteboard backend contract is missing: ${literal}" >&2
    exit 1
  fi
done
if grep -Fq 'nextcloud-releases/whiteboard:stable' "${backend_patch}" "${demo_values}"; then
  echo "ERROR: Whiteboard backend must not use a moving image tag" >&2
  exit 1
fi

if [ "$#" -eq 1 ]; then
  infra="$1"
  chart="${infra}/helmfile/apps/nextcloud/charts/nextcloud"

  # Render the actual pinned chart, not a copied fixture, and assert the command
  # produces the secured, immutable backend and same-origin route.
  command -v helm >/dev/null || {
    echo "ERROR: helm is required for rendered Whiteboard validation" >&2
    exit 1
  }
  helm dependency build "${chart}" >/dev/null
  rendered="$(mktemp)"
  trap 'rm -f "${rendered}"' EXIT
  helm template opensuite-nextcloud "${chart}" \
    --set cluster.routingMode=ingress \
    --set cluster.ingress.type=traefik \
    --set ingress.hostname=nextcloud.example.test \
    --set ingress.ingressClassName=traefik \
    --set whiteboard.enabled=true \
    --set whiteboard.authGateMiddleware=mb-bureaublad-opensuite-auth-gate@kubernetescrd \
    >"${rendered}"
  for literal in \
    'name: opensuite-nextcloud-whiteboard' \
    'ghcr.io/nextcloud-releases/whiteboard:v1.5.9@sha256:b60b7633f90d106ac6922f9bc27e1a1ca2442488b740fefdae4c812f34e9cebc' \
    'name: JWT_SECRET_KEY' \
    'path: /whiteboard' \
    'mb-bureaublad-opensuite-auth-gate@kubernetescrd' \
    'readOnlyRootFilesystem: true' \
    'kubernetes.io/metadata.name: kube-system' \
    'app.kubernetes.io/name: traefik'; do
    require_literal "${rendered}" "${literal}"
  done
fi

echo "Nextcloud Whiteboard source and rendered contracts verified"
