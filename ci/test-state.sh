#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

STATE_DIR="${TMP}/new"
source "${REPO_ROOT}/scripts/lib/state.sh"
opensuite_prepare_state_dir
[ "$(stat -c '%a' "${STATE_DIR}" 2>/dev/null || stat -f '%Lp' "${STATE_DIR}")" = "700" ]

opensuite_guard_install_identity example.test correct-horse
opensuite_master_fingerprint_matches correct-horse
if opensuite_master_fingerprint_matches wrong-horse; then
  echo "wrong master password matched fingerprint" >&2
  exit 1
fi

opensuite_write_state 0600 "${STATE_DIR}/demo-password" demo-secret
[ "$(cat "${STATE_DIR}/demo-password")" = "demo-secret" ]
[ "$(stat -c '%a' "${STATE_DIR}/demo-password" 2>/dev/null || stat -f '%Lp' "${STATE_DIR}/demo-password")" = "600" ]

mkdir -p "${TMP}/legacy"
printf '%s' legacy.test > "${TMP}/legacy/domain"
if (STATE_DIR="${TMP}/legacy"; source "${REPO_ROOT}/scripts/lib/state.sh"; opensuite_guard_install_identity legacy.test original); then
  echo "legacy install was adopted without explicit approval" >&2
  exit 1
fi
(
  STATE_DIR="${TMP}/legacy"
  OPEN_SUITE_ADOPT_MASTER_PASSWORD=true
  source "${REPO_ROOT}/scripts/lib/state.sh"
  opensuite_guard_install_identity legacy.test original
  opensuite_master_fingerprint_matches original
)

echo "state helper tests passed"
